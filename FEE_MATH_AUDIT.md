# Levy Fee Math Audit

Self-review of every arithmetic operation in `SubscriptionManager.sol` and
`FeeRouter.sol`. Integer math only; no floating point anywhere. Last revised
2026-10-24.

## 1. Protocol fee: `fee = due / FEE_BPS`

Location: `_collect()`, used by `subscribe()`, `charge()` and `changePlan()`.
`FEE_BPS = 100`, which gives 1%.

- `FEE_BPS` is a divisor, not basis points despite its name: 100 means
  `due / 100`, i.e. 1%. A redeploy that set it to 50 would charge 2%, not 0.5%.
- Integer division rounds **down**, so the protocol receives
  `floor(due / 100)`. What it gives up is `(due % 100) / 100`, always **under
  1 unit** ($0.000001), and it goes to the merchant, who receives `due - fee`.
  Nothing is burned or locked.
- `due < 100` units (under $0.0001): `fee = 0`. The merchant keeps everything;
  no revert.
- `due = 0` (proration credit covers the whole cycle): the pull and transfers
  are skipped (the `sub.credit >= plan.price` branch), and `Charged` emits
  `amount = 0, fee = 0`.
- The split is exact: `fee + (due - fee) == due`. The manager never retains a
  remainder (invariant `managerHoldsNothing`).

## 2. Proration: `credit += (oldPlan.price * remaining) / oldPlan.cycleSeconds`

Location: `changePlan()`. Billing is in advance, so a plan change bills the
new plan's first cycle immediately via `_collect()`, spending credit first.

- Credit is only earned while the current cycle is paid: `chargeCount > 0`
  and `nextChargeAt > now`. Before the first charge, `nextChargeAt` marks the
  end of an unpaid trial, so trial time earns nothing. Once anything has been
  charged, every write to `nextChargeAt` comes from a paid event (subscribe, a
  successful charge, a paid plan change) or from resume, which only moves a
  passed date up to now and so never creates credit-earning time.
- `remaining` is clamped to `oldPlan.cycleSeconds`, so one change adds at most
  `oldPlan.price`: the value of the cycle being abandoned.
- Credit is **added** to existing credit, not replaced, so credit carried from
  an earlier downgrade is not destroyed. It cannot stack beyond what was paid:
  treat `credit + unused value of the current cycle` as the subscriber's
  balance. A plan change converts the unused value into credit without growing
  the balance, and each new cycle is paid from that balance first, then with
  fresh USDC. So credit never exceeds the USDC the subscription has paid
  (fuzzed as `invariant_creditBacked`) or the largest plan price
  (`invariant_creditBounded`).
- Plan changes are same-merchant only, so credit is always spent at the
  merchant who received the USDC behind it.
- Rounding: integer division truncates, so the subscriber's credit is under
  **1 unit** below the exact prorated value. The shortfall stays with the
  merchant, who already collected the full price.
- Overflow: `price` is uint256 with no on-chain cap. `price * remaining`
  overflows only if `price > type(uint256).max / 315_360_000` (MAX_CYCLE = 10
  years in seconds), i.e. `price > ~3.67e68` units. That is absurd, and
  Solidity 0.8 reverts on overflow rather than wrapping, so even a malicious
  `price` fails closed. Realistic bound: $1B = 1e15 units;
  `1e15 * 3.15e8 = 3.15e23`, far below `1.15e77`.
- Credit application in `_collect()`: if `credit >= price`, the whole cycle is
  covered (`due = 0`) and the remainder carries forward; otherwise
  `due = price - credit` and credit zeroes out once the pull succeeds. A large
  credit from a downgrade (e.g. $10 of unused time moving to a $2 plan: $2 pays
  the new cycle, $8 carries) covers several later cycles.

**Correction (2026-09-25).** The first version of this audit missed that the
old `changePlan` minted credit for cycles that had never been paid (billing
was in arrears) and allowed switching to another merchant's plan. The
"credit <= oldPlan.price" bound held, but a subscriber could set that price
themselves. See SECURITY_REVIEW.md §9.

## 3. Six-decimal USDC: no conversion bugs

- The contracts never call `decimals()`, never multiply or divide by `1e6` or
  `1e18`, and never handle native value. All amounts are raw token units.
- The contracts themselves do not enforce 6 decimals, and the math is
  unit-agnostic (a 1% fee and integer proration behave the same at any decimal
  count). `script/Deploy.s.sol` does enforce it: it refuses to deploy unless the
  USDC address reports 6 decimals.
- No 18-decimal native values enter payment logic. The keeper pays gas in USDC
  natively, but that happens outside these contracts.

## 4. Timestamp arithmetic

- `nextChargeAt` and `start` are uint64. `block.timestamp` (~1.8e9) plus ten
  `MAX_CYCLE`s (~3.2e9) is ~5e9, far below uint64 max (~1.8e19). The
  `uint64(...)` casts cannot truncate in practice.
- `charge()` normally advances `nextChargeAt` by one `cycleSeconds` from the
  stored value, not from `block.timestamp`, so a late keeper does not shift the
  billing date. It sets `nextChargeAt = now + cycleSeconds` instead when the
  charge follows failed attempts (`failedAttempts > 0`, which covers every
  PAST_DUE recovery) or when one cycle after the stored value has already
  passed (a whole cycle went by uncharged, as in a keeper outage). The overdue
  time is forgiven, so a successful charge never leaves the next one already
  due and missed cycles are never pulled back to back (invariant
  `noBackToBackCharges`). Before the 2026-10-24 review every charge added one
  cycle to the stored value, so catching up took one `charge()` per missed
  cycle and a recovered subscription could be pulled for several overdue
  cycles in a row. Two other writes: resume moves a passed `nextChargeAt` up
  to the resume time (paused cycles are never billed), and `changePlan` sets
  it to `now + newCycle` (the new cycle is paid immediately). `nextChargeAt`
  never falls below `start` (invariant-tested).

## 5. Failure counters

- `failedAttempts` is uint64, incremented once per failed `charge()`. PAST_DUE
  at `>= maxFailed`; auto-PAUSED at `>= 2 × maxFailed`.
- `maxFailed` is uint8 (1..255), so the pause threshold is at most 510. The
  multiplication is `uint256(plan.maxFailed) * 2`. It used to be
  `plan.maxFailed * 2`, which is uint8 arithmetic and overflowed for
  `maxFailed >= 128`, so every failed pull on such a plan reverted with panic
  0x11 instead of being recorded. Found 2026-09-25 while checking this
  document; fixed, with a regression test and the invariant fuzzer now covering
  the full 1..255 range (it was bounded to 1..10, which is why it never hit
  this).
- Failures are recorded on the dunning schedule: `lastFailedAt[subId]` holds
  the last one, and a failing `charge()` before `lastFailedAt +
  retryGap(failedAttempts)` (1 day after the first failure, 3 after the
  second, 7 after each later one; 0 with no failure since the last success)
  reverts `RetryTooSoon`. So reaching the pause threshold takes at least
  `1 + 3 + 7 × (2 × maxFailed - 3)` days whoever calls `charge()` (1 day for
  `maxFailed` 1). `lastFailedAt` is a uint64 of `block.timestamp`; the sum is
  computed in uint256.
- `failedAttempts` resets to 0 on any successful charge, plan change or resume.
  A resume therefore starts a full new dunning run instead of re-pausing on the
  next failure. (Before 2026-09-25 resume kept the count, so `failedAttempts`
  could pass `2 × maxFailed`; deep fuzzing caught it.)

## 6. Edge cases

| Case | Behavior |
|---|---|
| `price = 1` unit | `fee = 0`; merchant gets 1 unit. No revert. |
| `due = 0` (credit covers all) | No token movement; cycle advances; `Charged(0, 0)`. |
| `changePlan` while overdue (`nextChargeAt <= now`) | No credit from unused time (none remains); the new plan's cycle is billed now (less any carried credit) and the overdue cycle is forgiven. Economically the same as cancel and resubscribe. |
| `changePlan` to a cheaper plan mid-cycle | Credit can exceed the new price; the excess covers later cycles. Correct. |
| `changePlan` during a trial | No credit; the new plan's first cycle is billed in full now. |
| Resume after `nextChargeAt` passed | `nextChargeAt` = resume time; one charge bills a fresh cycle. Paused cycles are never billed. |
| Successful charge after failed attempts, or after a whole cycle went uncharged | `nextChargeAt` = payment time + one cycle; the overdue time is not billed. |
| Merchant wants a higher price after the subscriber approved | Impossible on an existing plan: price is immutable. Repricing means a new plan, which the subscriber must choose via `changePlan`. |
| `permit2.transferFrom` amount | `uint160` cast guarded by an `amount > type(uint160).max` check; realistic USDC amounts are ~1e6 to 1e15. |

## 7. Findings

Three arithmetic or logic bugs were found after the first version of this
audit, all fixed on 2026-09-25: unbacked proration credit (§2 correction),
resume keeping the failure count (§5), and the `uint8` overflow in the
auto-pause threshold (§5). The 2026-10-24 review found one more, fixed the
same day: a successful charge after failed attempts moved the date one cycle
on from the missed one, so a recovered subscription could be pulled for
several overdue cycles back to back (§4). One design note:

1. `FEE_BPS = 100` is a constant, not a plan field, so changing the fee needs a
   redeploy. This is intentional (predictable for merchants). The planned
   Phase 2 fee split happens in the FeeRouter, not here (see SPEC.md).

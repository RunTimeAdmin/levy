# Levy Fee Math Audit

Self-review of every arithmetic operation in `SubscriptionManager.sol` and
`FeeRouter.sol`. Integer math only; no floating point anywhere.

## 1. Protocol fee: `fee = due / FEE_BPS`

Location: `_collect()`, used by `subscribe()`, `charge()` and `changePlan()`. `FEE_BPS = 100` (1%).

- Solidity integer division rounds **down**. `fee <= due / 100` always.
- Maximum dust per charge: `due % 100`, i.e. **at most 99 units** ($0.000099 at
  6 decimals). Dust is not burned or locked: the merchant receives
  `due - fee`, so dust accrues to the merchant.
- `due < 100` (sub-cent charges): `fee = 0`. The protocol earns nothing;
  the merchant keeps everything. No revert, no dust lockup.
- `due = 0` (full proration-credit coverage): the fee branch is skipped
  entirely (`if (due > 0)`); `Charged` emits `amount = 0, fee = 0`.
- The split is exact: `fee + (due - fee) == due`. The manager never retains a
  remainder (see invariant `managerHoldsNothing`).

## 2. Proration: `credit += (oldPlan.price * remaining) / oldPlan.cycleSeconds`

Location: `changePlan()`. Billing is in advance, so a plan change bills the
new plan's first cycle immediately via `_collect()`, spending credit first.

- Credit is only earned while the current cycle is paid: `chargeCount > 0`
  and `nextChargeAt > now`. Before the first charge, `nextChargeAt` marks the
  end of an unpaid trial, so trial time earns nothing. Once anything has been
  charged, every write to `nextChargeAt` comes from a paid event (subscribe,
  a successful charge, or a paid plan change).
- `remaining` is clamped to `oldPlan.cycleSeconds`, so one change adds at most
  `oldPlan.price`: the value of the cycle being abandoned.
- Credit is **added** to existing credit, not replaced, so credit carried from
  an earlier downgrade is not destroyed. It cannot stack beyond what was paid:
  treat `credit + unused value of the current cycle` as the subscriber's
  balance. A plan change converts the unused value into credit without
  growing the balance, and each new cycle is paid from that balance first,
  then with fresh USDC. So credit never exceeds the USDC the subscription has
  paid (fuzzed as `invariant_creditBacked`) or the largest plan price
  (`invariant_creditBounded`).
- Plan changes are same-merchant only, so credit is always spent at the
  merchant who received the USDC behind it.
- Rounding: integer division truncates, so the subscriber's credit is at most
  **1 unit** ($0.000001) below the exact prorated value. The shortfall stays
  with the merchant, who already collected the full price.
- Overflow: `price` is uint256 with no on-chain cap. `price * remaining` overflows
  only if `price > type(uint256).max / 315_360_000` (MAX_CYCLE = 10 years in
  seconds), i.e. `price > ~3.6e68` units = $3.6e62. Absurd by ~50 orders of
  magnitude above any real USDC supply. Solidity 0.8 reverts on overflow rather
  than wrapping, so even a malicious `price` fails closed (revert, not theft).
  Realistic bound: $1B = 1e15 units; `1e15 * 3.15e8 = 3.15e23 << 1.15e77`. Safe.
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

- The contracts never call `decimals()`, never multiply/divide by `1e6` or
  `1e18`, and never handle native ETH. All amounts are raw token units.
- The 6-decimal convention is documentation-level (README, SPEC, MockUSDC),
  not enforced on-chain. The math is unit-agnostic: a 1% fee and integer
  proration behave identically at any decimal count, so deploying against a
  differently-decimaled token would not break accounting — it would just
  change what "price = 10_000_000" means. The deployment checklist must still
  pin the Arc USDC ERC-20 interface (`0x3600...0000`).
- No 18-decimal native values enter payment logic. The keeper pays gas in
  USDC natively, but that happens outside these contracts.

## 4. Timestamp arithmetic

- `nextChargeAt`, `start` are uint64. `block.timestamp` (~1.7e9) plus ten
  `MAX_CYCLE`s (~3.2e9) is ~5e9, far below uint64 max (~1.8e19). The
  `uint64(...)` casts cannot truncate in practice.
- `charge()` advances `nextChargeAt` by exactly one `cycleSeconds` per call
  (from the stored value, not `block.timestamp`), so a late keeper does not
  cause multi-cycle surprise pulls; catching up requires one `charge()` per
  missed cycle. `nextChargeAt` never moves backwards (invariant-tested).

## 5. Failure counters

- `failedAttempts` is uint64, incremented once per failed `charge()`.
  `PAST_DUE` at `>= maxFailed`; auto-`PAUSED` at `>= maxFailed * 2`.
  `maxFailed` is uint8 (max 255), so the pause threshold is at most 510.
  No overflow: `maxFailed * 2` is computed in uint256 context (Solidity 0.8
  arithmetic on uint8 promotes safely here; 255*2 = 510 fits).
- `failedAttempts` resets to 0 on any successful charge or plan change.

## 6. Edge cases

| Case | Behavior |
|---|---|
| `price = 1` unit | `fee = 0`; merchant gets 1 unit. No revert. |
| `due = 0` (credit covers all) | No token movement; cycle advances; `Charged(0,0)`. |
| `changePlan` while overdue (`nextChargeAt <= now`) | No credit from unused time (none remains); the new plan's cycle is billed now (less any carried credit) and the overdue cycle is forgiven. Economically identical to cancel + resubscribe. |
| `changePlan` to a cheaper plan mid-cycle | Credit can exceed the new price; the excess covers later cycles. Correct. |
| `changePlan` during a trial | No credit; the new plan's first cycle is billed in full now. |
| Subscriber approves exactly `price`, then price... | Price is immutable per plan; no repricing race. |
| `permit2.transferFrom` amount | `uint160` cast guarded by `amount > type(uint160).max` check; realistic USDC amounts are ~1e6–1e15. |

## 7. Findings

One logic bug was found after this audit and fixed (see the §2 correction).
One documentation-level note:

1. `FEE_BPS = 100` is a constant, not a plan field. Changing the fee requires
   redeployment. This is intentional (predictability for merchants) and noted
   in the README's Phase 2 FeeRouter plans.

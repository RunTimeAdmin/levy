# Levy Security Self-Review

Adversarial read of `SubscriptionManager.sol` and `FeeRouter.sol` before any
paid audit. Goal: find problems, not confirm correctness.

## 1. Access control

| Function | Who can call | Verdict |
|---|---|---|
| `createPlan` | anyone | OK — plan is scoped to `msg.sender` as merchant; no cross-merchant effect. |
| `subscribe` | anyone (as themselves) | OK — subscriber is `msg.sender`. |
| `subscribeWithPermit2` | anyone (for any `owner` with valid sig) | OK — EIP-712 signature binds `owner`; submitter cannot impersonate. See §7. |
| `charge` | anyone | OK by design — see §4. |
| `pause/resume/cancelSubscription` | subscriber or plan merchant | OK — `_onlySubscriberOrMerchant`. |
| `changePlan` | subscriber only | OK — `msg.sender != sub.subscriber` reverts. Merchant cannot force-migrate. |
| `FeeRouter.sweep` | anyone | OK — destination is fixed to `treasury`. |
| `FeeRouter.setTreasury` | current treasury only | OK. |

No missing access control found. Plans are immutable (no edit function), so
there is no repricing or merchant-swap attack.

## 2. Reentrancy

- `charge()` is `nonReentrant`. External calls: `usdc.transferFrom` (inside
  `_tryPull`), `permit2.transferFrom` (fallback), two `usdc.safeTransfer`s.
  With standard USDC (no transfer callbacks, not ERC-777), there is no
  reentrant code path — the guard is defense-in-depth. If USDC were ever
  replaced by a callback-y token, the guard plus checks-effects-interactions
  ordering (state updates after transfers... see note below) would matter.
- Note: in `charge()`, the two `safeTransfer`s happen BEFORE
  `nextChargeAt`/`failedAttempts`/`status` are updated. This is
  checks-effects-interactions *inverted*, but safe here because (a) USDC has
  no callbacks, (b) `nonReentrant` blocks the only reentrant entry points.
  If the token ever changes, reorder to update state first.
- `changePlan()` is `nonReentrant` but makes zero external calls — the guard
  is unnecessary but harmless.
- `subscribeWithPermit2()` is NOT `nonReentrant` and calls the untrusted
  `permit2.permit()`. Worst case if Permit2 is malicious: reentrant
  `subscribe*` calls create extra subscriptions (attacker pays gas, no funds
  move in subscribe). No fund-loss path. Acceptable; a guard could be added
  for hygiene.

## 3. Keeper griefing (allowance games)

- `charge()` never reverts on payment failure — it records `ChargeFailed` and
  returns. A subscriber who revokes allowance cannot make the keeper's
  transaction revert; they can only waste one tx worth of gas per attempt.
- Griefing is **bounded**: after `maxFailed * 2` failures the contract
  auto-pauses the subscription (`AutoPaused`), and the keeper's dunning
  schedule stops retrying paused subs. With the default `maxFailed = 2`, a
  malicious subscriber can waste at most ~4 keeper transactions.
- Allowance front-running (subscriber sees keeper's `charge()` in mempool and
  revokes first): the charge fails gracefully, dunning handles it. No theft,
  just a wasted tx. Same bound as above.
- Spam subscriptions to waste keeper gas: anyone can `subscribe()` cheaply,
  but each spam sub costs the attacker gas and auto-pauses after failures.
  The keeper's `dueSubscriptions` query is off-chain and indexed. Low risk;
  monitor keeper gas spend in production.

## 4. `charge()` permissionless safety — can it steal or misroute?

No. Trace the fund flow for `charge(subId)` called by an arbitrary attacker:

1. `sub` and `plan` are loaded from storage; attacker cannot influence them.
2. `due` is derived from `plan.price` and `sub.credit`. Attacker cannot inflate it.
3. `_tryPull(sub.subscriber, due)` moves tokens **from the subscriber to
   `address(this)`** — never from anyone else, never to the attacker.
4. `usdc.safeTransfer(plan.merchant, due - fee)` — merchant is plan-immutable.
5. `usdc.safeTransfer(feeRouter, fee)` — router is constructor-immutable.
6. `invoiceRef` is a deterministic hash; not fund-controlling.

There is no path where the caller receives tokens or redirects them. The only
"gain" from calling `charge()` is triggering someone else's payment — which is
the protocol's purpose. Frontrunning `charge()` is meaningless: the outcome is
identical regardless of caller.

## 5. FeeRouter trust assumptions

- `treasury` is a single EOA/multisig set at construction. If the key is lost,
  `sweep()` still works (permissionless) but sends to a dead address —
  operational risk, not a contract bug. Mitigation: `setTreasury` (requires
  current treasury) and the planned Safe multisig (M4).
- `sweep()` with zero balance emits `Swept(0)`; harmless.
- The router cannot be paused or killed. There is no scenario where the
  manager's fee payments get stuck: every `charge()` pushes fees to the
  router atomically; the router only ever forwards.
- Phase 2 (buyback/staking split) is not implemented — the contract is an
  honest forwarder today, which matches the docs.

## 6. Integer / rounding

Covered in `FEE_MATH_AUDIT.md`. Summary: fee dust (max 99 units) goes to the
merchant; proration dust (max 1 unit) stays with the merchant; no overflow is
reachable (`price * remaining` needs $3.6e62 to overflow); `failedAttempts`
cannot overflow its bounds.

## 7. Permit2 subscribe path

- `subscribeWithPermit2` validates `permitSingle.spender == address(this)` and
  `details.token == usdc` **before** calling `permit()`. Without these, a
  signature authorizing a different spender/token would be submitted pointlessly
  (funds stay safe — Permit2 enforces the signed spender — but the user experience
  would be a silent no-op allowance). The checks fail fast with clear errors.
- The `owner` parameter is explicit so the keeper can submit. The EIP-712
  signature is verified against `owner` by Permit2 itself; a submitter cannot
  forge or replay for a different owner (nonce binds each signature to one use).
- Residual consideration: the signed permit does not bind `planId`. A relayer
  holding Alice's valid signature could subscribe her to a *different* plan
  than she intended. Impact is low (she can cancel/changePlan; the permit amount
  may not even cover the other plan's price, causing immediate dunning), but
  frontends should treat the (permit, planId) pair as a unit and submit both
  together.
- `_tryPull` tries direct `transferFrom` first, then Permit2. A subscriber with
  both allowances always spends the direct one first (tested). No double-spend:
  the first success returns immediately.
- `uint160` cast on the Permit2 amount is guarded (`amount > type(uint160).max`
  returns false). Realistic USDC amounts are orders of magnitude below the bound.
- If the Permit2 allowance `expiration` passes, charges fail gracefully into
  dunning. No on-chain reminder exists — the dashboard/keeper should surface
  expiring allowances (M3/M4 work).

## 8. Denial of service

- No unbounded loops anywhere. All state-changing functions are O(1).
- `charge()` on an already-paid-up subscription reverts (`NotChargeable` on the
  timestamp check) — no free gas burn.
- `cancelSubscription` is terminal; `charge()` on cancelled reverts. The
  invariant suite fuzzes this (`cancelIsTerminal`).

## 9. Findings

**No fund-loss or theft vectors found.** Notes for the paid audit / M4:

1. `charge()` updates `nextChargeAt`/`failedAttempts`/`status` *after* the
   `safeTransfer`s (CEI inverted). Safe with standard USDC + `nonReentrant`,
   but flag it for the auditor.
2. `changePlan` while a charge is overdue forgives the overdue cycle
   (economically equivalent to cancel + resubscribe; not a bug, but confirm
   the product intends this).
3. Consider adding `nonReentrant` to `subscribeWithPermit2` for hygiene
   (untrusted external call to Permit2).
4. The keeper should index `AutoPaused` events (emitted on 2x auto-pause) —
   currently the dunning schedule relies on the status flip being picked up
   via subscription refresh.
5. Treasury key management is the largest non-contract risk: single-key
   treasury until the M4 multisig lands.

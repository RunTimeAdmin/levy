# Levy Security Self-Review

Adversarial read of `SubscriptionManager.sol` and `FeeRouter.sol` before any
paid audit, plus a short section on the off-chain services. Goal: find
problems, not confirm correctness. Last revised 2026-10-24.

## 1. Access control

| Function | Who can call | Verdict |
|---|---|---|
| `createPlan` | anyone | OK: the plan is scoped to `msg.sender` as merchant; no cross-merchant effect. See §3 for the spam-plan cost to the keeper. |
| `subscribe(planId, ref)` | anyone, as themselves | OK: the subscriber is `msg.sender`. `ref` is chosen by the caller and public; see §7. |
| `subscribeWithPermit2(planId, ref, permit, sig)` | the permit signer only | OK: the owner is `msg.sender`, so a relayer cannot pick the plan. See §6. |
| `charge` | anyone | OK by design; see §4. |
| `pause/cancelSubscription` | subscriber or plan merchant | OK: `_onlySubscriberOrMerchant`. |
| `resumeSubscription` | subscriber, or the merchant for a pause it made | OK since 2026-10-24 (M-1 in the 2026-10-24 review): resuming restarts billing against the subscriber's allowance, and the merchant could resume a subscriber's pause or an auto-pause. Now only a pause recorded in `pausedByMerchant`; otherwise `NotSubscriber`. |
| `changePlan` | subscriber only, same-merchant plans only | OK: `msg.sender != sub.subscriber` reverts; a plan from another merchant reverts `DifferentMerchant`. The merchant cannot force-migrate. |
| `FeeRouter.sweep` | anyone | OK: the destination is fixed to `treasury`. |
| `FeeRouter.proposeTreasury` / `acceptTreasury` | current treasury proposes, the proposed address accepts | OK: two steps since 2026-10-24 (L-3), so a mistyped address never takes over. |

No missing access control found. Plans are immutable (no edit function), so
there is no repricing or merchant-swap attack.

## 2. Reentrancy

- Every function that moves tokens is `nonReentrant`: `subscribe` and
  `subscribeWithPermit2` (they pull the first cycle when the plan has no
  trial), `charge`, and `changePlan` (it bills the new plan). All of them go
  through `_collect`, whose external calls are `usdc.transferFrom` (inside
  `_tryPull`), `permit2.transferFrom` (fallback) and two `usdc.safeTransfer`s.
  `subscribeWithPermit2` also calls `permit2.permit()` first, under the same
  guard. With standard USDC (no transfer callbacks, not ERC-777) there is no
  reentrant path; the guard is defense in depth.
- State updates (`nextChargeAt`, `failedAttempts`, `status`) happen after the
  transfers: checks-effects-interactions inverted. Safe with USDC. With a token
  that made callbacks it would matter, and `pause/resume/cancelSubscription`
  are not guarded: a cancel made from inside `changePlan`'s transfer would be
  overwritten by its `status = ACTIVE`. Flag for the auditor; reorder if the
  token ever changes.

## 3. Keeper griefing and gas

- A failed pull does not revert `charge()`: it records `ChargeFailed` and
  returns, unless it falls inside the `retryGap` window, where `charge()`
  reverts `RetryTooSoon` and changes nothing. A subscriber who revokes their
  allowance cannot make the keeper's first attempt revert; each attempt wastes
  one keeper transaction.
- That is bounded per subscription: after `2 × maxFailed` failures the
  contract auto-pauses it, and the keeper stops retrying paused
  subscriptions. With `maxFailed = 2` (what the tests use) that is about 4
  keeper transactions per resume. Resume resets the failure count and a
  subscriber can resume their own subscription, so each resume (paid by the
  attacker) buys another round.
- The contract records failures only on the dunning schedule: `retryGap`
  requires 1 day before the second failure, 3 days before the third and 7
  before each later one; a failing `charge()` sooner reverts `RetryTooSoon`.
  `charge()` is permissionless, so without this a third party could call it
  repeatedly while a pull fails and pause the subscription in one block (H-1,
  §9), and with only a flat 1-day gap still pause it on day 3 instead of day
  11 (finding 2 of the 2026-10-02 review). Auto-pause now takes at least
  `1 + 3 + 7 × (2 × maxFailed - 3)` days after the first failure (1 day for
  `maxFailed` 1), whoever calls `charge()`.
- Allowance front-running (revoke just before the keeper's `charge()`): the
  charge fails gracefully and dunning handles it. No theft; same bound.
- **Mitigated: self-funded spam subscriptions.** Anyone can create a plan
  priced at 1 unit and subscribe to it themselves. The attacker pays themselves
  (fee 0), so those charges never fail and never auto-pause, and the keeper
  pays gas for every one. With no minimum cycle that was a charge every keeper
  cycle (30s) per subscription. Since 2026-09-25 the contract enforces
  `MIN_CYCLE = 1 days`, so each such subscription costs the keeper at most one
  charge a day. It is still unbounded across many subscriptions and over time
  (each costs the attacker one subscribe transaction). Watch the keeper's
  balance and spend (`ops/monitoring.md` alert 6); if it grows, add a keeper policy (skip
  subscriptions whose fee does not cover gas, or charge only listed merchants).

## 4. `charge()` permissionless safety: can it steal or misroute?

No. Trace `charge(subId)` called by an arbitrary attacker (the pull and split
live in `_collect`, shared with `subscribe` and `changePlan`):

1. `sub` and `plan` are loaded from storage; the attacker cannot influence them.
2. `due` is `plan.price` minus the subscription's credit. Credit only comes
   from a paid cycle (see `FEE_MATH_AUDIT.md` §2), so it cannot be inflated.
3. `_tryPull(sub.subscriber, due)` moves tokens **from the subscriber to the
   manager**, never from anyone else and never to the caller.
4. `usdc.safeTransfer(plan.merchant, due - fee)`: the merchant is fixed per plan.
5. `usdc.safeTransfer(feeRouter, fee)`: the router is fixed at construction.
6. `invoiceRef` is a deterministic hash and moves no funds.

The caller never receives or redirects tokens; front-running `charge()` changes
nothing. The one thing a caller does control is when a failing pull is
recorded, and the contract spaces those on the dunning schedule (§3).

## 5. FeeRouter trust assumptions

- `treasury` is set at construction. `script/Deploy.s.sol` refuses a mainnet
  deploy unless it is a contract (the Safe from `ops/treasury-multisig.md`),
  but the treasury can later hand over to any non-zero address that accepts,
  including an EOA. The handover takes two transactions since 2026-10-24
  (`proposeTreasury`, then `acceptTreasury` from the new address), so a typo
  can no longer send future fees to an address nobody controls. If the
  treasury's keys are lost, `sweep()` still works (it is permissionless) but
  sends to an address nobody controls.
- `sweep()` with a zero balance emits `Swept(0)`; harmless.
- The router cannot be paused or killed, and fee payments cannot get stuck:
  `subscribe`, `charge` and `changePlan` push the fee to the router in the same
  transaction as the pull, and the router only ever forwards.
- Phase 2 (buyback and staking split) is not implemented; the router is a plain
  forwarder today.

## 6. Permit2 subscribe path

- `subscribeWithPermit2` checks `permitSingle.spender == address(this)` and
  `details.token == usdc` **before** calling `permit()`, so a signature for a
  different spender or token fails fast instead of producing a useless
  allowance.
- The owner is `msg.sender`; there is no `owner` parameter. Permit2 verifies the
  EIP-712 signature against it, and the nonce makes each signature single use.
- Why relaying is not allowed: the signed permit does not bind `planId`. An
  earlier version took an explicit `owner` so the keeper could relay; anyone
  holding the signature (a relayer, or anyone reading it from the mempool)
  could then subscribe the owner to a plan of their own and, with a 1-second
  cycle (allowed then) or the up-front first charge, drain the permit amount
  almost at once.
  Removed 2026-09-25. Relaying could come back only with a second signature
  that binds the plan.
- Fixed 2026-10-24 (L-2 in the 2026-10-24 review): anyone who sees the signed
  permit in the mempool can submit it to Permit2 directly first, using up the
  nonce, and `subscribeWithPermit2` reverted. No funds were lost. It now
  catches the failed `permit()` and goes on when the subscriber's Permit2
  allowance for Levy already covers one cycle of the plan and has not
  expired; otherwise it re-throws Permit2's own error.
- `_tryPull` tries the direct `transferFrom` first, then Permit2. A subscriber
  with both allowances spends the direct one first (tested). The first success
  returns, so there is no double spend.
- The `uint160` cast for Permit2 is guarded (`amount > type(uint160).max`
  returns false).
- An expired Permit2 allowance makes charges fail into dunning. The keeper's
  allowance warnings read only the direct ERC-20 allowance, so they do not
  cover Permit2 subscribers (who are flagged low from the start).

## 7. Merchant reference (`ref`)

- `subscribe` and `subscribeWithPermit2` take a `bytes32 ref`, stored in the
  public `subscriptionRef` mapping and emitted in `Subscribed`. It moves no
  funds and grants no rights.
- It is public, so it must be an opaque token. It is chosen by whoever
  subscribes, so it is a claim, not a proof: anyone can copy a victim's ref from
  chain data (for free on a trial plan) and subscribe with it, then cancel,
  making the victim's account look cancelled to a merchant that matches on ref
  alone. Merchants should issue unguessable per-checkout refs and, once
  `subscription.created` links a ref to a customer, track that subscription by
  `subId` (and check the subscriber and plan). The merchant guide says so.

## 8. Denial of service

- No unbounded loops. All state-changing functions are O(1).
- `charge()` before `nextChargeAt` reverts `NotChargeable`, so there is no free
  gas burn on a paid-up subscription.
- `cancelSubscription` is terminal; `charge()` on a cancelled subscription
  reverts. The invariant suite fuzzes this (`cancelIsTerminal`).
- Open, operational: if USDC blocklists a plan's merchant (or the FeeRouter),
  `safeTransfer` reverts and so does the whole charge. The subscriber is not
  charged; the keeper backs off retries (1m to 6h). Only a new plan fixes it.

## 9. Findings

**Found and fixed** (this review missed the first, the fifth and the sixth):

- **Unbacked proration credit.** Billing was effectively in arrears (the first
  charge came one cycle after subscribe), yet `changePlan` credited "unused"
  time on a cycle nobody had paid for, and accepted plans from any merchant. A
  subscriber could create their own plan priced at 1e30, subscribe without
  paying, switch to a real merchant's plan and ride the credit for free cycles
  indefinitely, each emitting `Charged(0, 0)` and a `charge.succeeded` webhook.
  Hopping between plans just before each charge also deferred payment forever.
  Fix: advance billing (the first cycle is paid at subscribe unless the plan has
  a trial; a plan change bills the new plan immediately), credit only from a
  paid cycle, same-merchant plan changes only. Regression tests and
  `invariant_creditBacked` cover it.
- **Relayed Permit2 subscribe.** Rated low here originally, but a 1-second cycle
  (allowed then) turned a copied permit into a near-instant drain. Fixed by making
  `msg.sender` the permit owner (§6).
- **Resume billed paused cycles and kept the failure count.** Resuming after a
  long pause let anyone charge every paused cycle at once, and a resumed
  subscription went past `2 × maxFailed` on its next failure. Resume is now a
  fresh start: a passed `nextChargeAt` moves to the resume time and
  `failedAttempts` resets.
- **`maxFailed * 2` overflowed `uint8`.** For any plan with `maxFailed >= 128`,
  every failed pull reverted with panic 0x11 instead of being recorded, so the
  subscription never went PAST_DUE or auto-paused. Now `uint256(maxFailed) * 2`;
  the invariant fuzzer covers the full 1..255 range.
- **No minimum cycle length.** A 1-second plan let a self-paying subscription
  cost the keeper gas every cycle and let a mistaken approval be drained within
  seconds. `createPlan` now requires `cycleSeconds >= MIN_CYCLE` (1 day).
- **Failures could be recorded back to back (H-1).** Found by an
  external engineering review dated 2026-09-25 (`docs/REVIEW_2026-09-25.md`,
  PR #1) and fixed on 2026-09-26, after the first testnet deploy. `charge()`
  is permissionless and a failed pull did not move `nextChargeAt`, so anyone
  could call it `2 × maxFailed` times in one block while a subscriber's pull
  was failing and push the subscription from ACTIVE to PAUSED at once,
  skipping the off-chain dunning schedule. No funds could move. Fixed first
  by a flat 1-day gap between recorded failures, then (2026-10-02 review,
  finding 2) by the full schedule, `retryGap` (§3): 1, 3, then 7 days, a
  sooner failing call reverts `RetryTooSoon`, successful charges are never
  held back, and resume clears the timer. The review's proof of concept
  became regression tests (`test/FailureCooldown.t.sol`, including a griefer
  calling every day who cannot pause before day 11), and
  `invariant_failuresSpaced` fuzzes it with a griefing action. Found after
  the first testnet deploy; the contracts were redeployed before the soak.
- **Second external review (2026-10-02, `docs/REVIEW_2026-10-02.md`).**
  Fixed: the schedule above (finding 2); the deploy script now refuses any
  USDC or Permit2 but the canonical ones on Arc mainnet (4); the checkout
  shows exact amounts (7), never invites a blind retry after a transaction
  whose result is unknown, keeps sent transactions across reloads and fixes
  the approval total so a retry cannot add the cycles twice (8), and checks
  the wallet really is on Arc after a switch (9). Open, before mainnet: a
  keeper policy for uneconomic plans (3, open item 1 below), verified
  merchant identity on the checkout (5), a Permit2 checkout path and Permit2
  allowances in the runway check (6), and rebuilding dunning state from the
  chain after keeper database loss (10). Finding 1 (the soak had not
  started) is a status item.
- **Third external review (2026-10-06, `docs/REVIEW_2026-10-06.md`), checked
  against the code and the live testnet on 2026-10-07.** None of it needs a
  contract change, so the soak deployment's contracts stand. Confirmed in the
  source and open before mainnet: items 7 to 12 below. Already open and raised
  again: uneconomic plans (3, item 1), merchant identity on the checkout (5),
  Permit2 allowances in the runway check (6, seen live: the keeper reports S5
  as `covers 0`) and dunning after keeper database loss (10: `DUE_CHARGEABLE`
  leaves `PAST_DUE` to the dunning table and `backfillAll` never writes it).
  Not defects: "no CI run for `5a4527f`" (that merge commit says `[skip ci]`
  on purpose; the next push runs CI), "zero plans and subscriptions" (true on
  6 October; the soak's day 0 was 2026-10-07 03:30:56 UTC) and "Permit2 not
  exercised on the current manager" (S5 subscribed through it as #5). The
  soak host stays on `08991fa` until the soak ends; fixes land on `main` and
  deploy afterwards.
- **Fourth external review (2026-10-24, `docs/REVIEW_2026-10-24.md`).**
  Conditional go for mainnet once M-1 and M-2 were fixed. All of it was
  checked against the code. Fixed as below; both contracts change, and they
  were deployed to Arc testnet on 2026-10-24 for soak 2:
  - M-1, a merchant could resume a pause the subscriber made, or an
    auto-pause, and bill again at once. `pausedByMerchant` now records a
    merchant's pause, the only kind the merchant may resume (§1). The
    dashboard offers Resume only for those.
  - M-2, after a run of failures `nextChargeAt` stayed in the past, so once
    the subscriber's allowance or balance came back anyone could call
    `charge()` repeatedly and pull every missed cycle in one block (on a
    daily plan, one pull per missed day). A successful charge after failed
    attempts now starts a fresh cycle at the payment, as resume does, and so
    does one after a whole cycle passed with no charge at all.
    `invariant_noBackToBackCharges` checks that a successful charge never
    leaves the subscription chargeable; with the fix removed, the CI profile
    (1000 x 40) fails it, the default 256 x 15 does not.
  - L-2, the Permit2 nonce front-run (§6, open item 4).
  - L-3, a single-step `setTreasury` (§5, open item 6).
  - The `fast-uri` advisories (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h and
    two later ones) and a low `fastify` advisory: the API lock file now has
    fastify 5.12.7; `npm audit` is clean for both services.
  Already in place, so no change: the keeper backs off charges that revert
  (L-1, see §8); the checkout approves price times N cycles, not unlimited,
  and the Permit2 script sets an expiry (L-4); CI runs the node tests on
  Node 24 (the reviewer's Node 20 lacked `node:sqlite`; on Node 22.23 the
  keeper's 56 and the API's 55 tests pass). Not done: paying the merchant by
  withdrawal instead of a push (L-1, open item 5).

**Open** (for the paid audit and M4):

1. Self-funded spam subscriptions still cost the keeper one charge a day each,
   unbounded in number and time (§3). Watch keeper gas; add a keeper policy if
   it grows.
2. CEI inverted in `_collect` callers, and unguarded pause/resume/cancel (§2).
   Safe with USDC; flag for the auditor.
3. `changePlan` and resume both forgive an overdue cycle (economically the same
   as cancel and resubscribe), and since 2026-10-24 so does a charge that
   recovers from failures. Decided 2026-10-24: forgiving is intended; a
   recovery starts a fresh cycle instead of keeping the billing date.
4. Fixed 2026-10-24: the permit nonce front-run no longer makes
   `subscribeWithPermit2` revert (§6).
5. A USDC-blocklisted merchant makes every charge for their plans revert (§8).
   The 2026-10-24 review (L-1) suggests holding the merchant's share for
   withdrawal instead of pushing it; not done.
6. The treasury can still hand over to an EOA after deploy (§5). Since
   2026-10-24 the handover is two-step, so a mistyped address cannot take it.
7. Checkout: a second tab that connected before the first tab's broadcast
   does not stop at the pending record (the Go handler loads it but never
   checks `subscribeHash`), and the record expires after a day or is lost when
   storage is blocked. Fix: persist the order beyond a day, coordinate tabs,
   reconcile with the chain before offering another subscribe. Do not ban
   repeat subscriptions per wallet and plan; they can be legitimate.
8. Portal Top up adds rounds to the allowance it reads at click time and is
   re-enabled after an unknown outcome (`changeAllowance`), so an approval that
   mined but whose receipt was unreadable can be topped up twice. Allowance
   only, no funds move. Fix: persist the target total, as checkout does.
9. Keeper replay. The cursor moves after each chunk, the `Charged` case
   ignores `insertCharge`'s result and still queues webhooks, `charge_failures`
   has no unique key, every enqueue gets a fresh delivery id, and a failure is
   stamped with the sync time rather than its block time (a late catch-up
   postpones retries). Fix: key events by transaction hash and log index, take
   the failure time from the block, test a crash between handling and cursor
   commit.
10. Webhook retries stop earlier than "24 hours" suggests. The schedule is 1
    minute, 5 minutes, 15 minutes, 1 hour, then 6 hours, and a delivery whose
    next retry would pass 24 hours is dead-lettered, so the last attempt is at
    19 h 21 min. The docs (README, merchant guide, public docs page, whitepaper,
    wiki) now say so as of 2026-10-07; the schedule itself is unchanged. Decide
    whether to keep it or add a final attempt nearer 24 hours.
11. The wallet checks the network at connect only; `send()` does not check it
    again before each transaction. Low: the manager address has no code on
    the other Arc network, so the wrong-network case wastes gas.
12. Reproducible build. `foundry.toml` does not pin `solc`. The deployment used
    0.8.33. Building the same sources with 0.8.30 reproduces the reviewer's
    33-byte difference in the metadata tail, with the code body identical
    apart from the immutables (tested 2026-10-07; line endings made no
    difference). Pin 0.8.33, keep the standard JSON input, then verify the
    source on the explorer, which publishes it and needs David's OK.
    `foundry.lock` also records OpenZeppelin v5.7.0 at `cab19933` while the
    submodule is pinned to `4858ab13`; reconcile the two.
13. A dunning row is cleared only when a charge succeeds, a subscription
    resumes or its retry time passes with the subscription no longer
    chargeable. Pausing or cancelling does not clear it, so the dashboard's
    retry queue and `dunningDepth` still list those subscriptions until the
    stale retry time arrives. Cosmetic: nothing is charged.
14. `ops/docker-compose.yml` gives the keeper and the API container the same
    `env_file`, so the internet-facing API holds `LEVY_KEEPER_KEY`, which only
    the keeper reads. A compromised API would expose the keeper's gas key (gas
    funds only, since `charge()` is permissionless anyway). Give each service
    its own env file or an explicit `environment` list.
15. The CI ABI drift check compares `keeper/abi/*.json` with the compiled
    contracts but not the `.bin` files that the keeper integration test deploys,
    so a stale `.bin` would pass CI.

## 10. Off-chain services (keeper and API)

Reviewed independently on 2026-09-25; details in `api/README.md` and
`keeper/README.md`.

- **API:** Sign-In with Ethereum (EIP-4361) bound to a configured origin,
  single-use challenges, 24h sessions stored hashed. Every data endpoint is
  scoped to the signed-in address; another merchant's ids return 404. No auth
  bypass or cross-merchant access was found.
- **Webhooks:** URLs must be https on port 443 at a public address, checked at
  registration and again at connect time (no DNS-rebinding window); redirects
  are never followed; failures record coarse reasons only. Signatures cover
  timestamp, delivery id, event type and body, so captured deliveries cannot be
  replayed later. Delivery runs in its own loop, so a hanging endpoint cannot stall
  charging.
- **Keeper:** fetches only Levy's logs, backs off charges that revert, and
  should run as a single instance. A second keeper cannot double-charge or
  speed up dunning (its second failing call reverts `RetryTooSoon`); it only
  wastes gas and log queries.
- **Pages:** since 2026-09-26 the dashboard, portal and checkout send a
  Content-Security-Policy that allows scripts only from the app's own origin
  and never inline (the page scripts moved to `/public/*.js`), so an injected
  script cannot run. They also refuse framing. Inline styles stay allowed;
  they cannot run code.
- **Page sessions (L-9 in docs/REVIEW_2026-09-25.md):** since 2026-09-26 the
  pages keep the session in an HttpOnly, SameSite=Strict, `__Host-` cookie
  instead of a bearer token in localStorage, so no script can read or steal
  it. Cookie-authenticated writes must carry the app's `Origin` (else 403),
  which also stops sibling sites such as getlevy.xyz that SameSite treats as
  the same site. Backends still use bearer tokens.
- **Open:** rate limiting of `POST /api/auth/challenge` is left to the
  reverse proxy (done in `ops/nginx-app.conf.example`); sign-in supports EOA
  wallets only (no ERC-1271); merchant
  backends sign in with their payout wallet (no scoped API keys yet).
- **Fixed (L-10 in docs/REVIEW_2026-09-25.md):** the signature now covers the
  `X-Levy-Event` header: `{timestamp}.{deliveryId}.{event}.{body}`. Receivers
  reject unknown event types, so the signed text cannot be split at a
  different dot (event names contain dots).

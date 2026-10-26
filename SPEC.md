# LEVY: Subscription Billing on Arc

**Status:** living build doc, updated 2026-10-25. Contracts, keeper, API, merchant dashboard, customer portal and checkout are built and tested. The contracts are deployed on Arc testnet for the M4 soak (addresses in README, Deployments); nothing is on mainnet. Soak 1 ran from 2026-10-07 to 2026-10-24; the contracts with the fixes from the 2026-10-24 review were deployed that day for soak 2. Manager v2 (`docs/manager-v2-design.md`: merchant accounts, retired plans, cycle limits, intro prices, subscription transfers) is built and tested but not deployed; this spec describes it, and the soak 2 contracts predate it. Verified chain facts are in `VERIFICATION.md`.
**One-liner:** Stripe Billing for Arc. Merchants create plans, subscribers approve a USDC allowance once, Levy pulls USDC every cycle with dunning, proration, webhooks and invoice records built in.

## Why this, why Arc, why now

- Circle names software billing a target Arc use case. Nothing live fills it; only testnet toys exist.
- Arc is purpose-built for money movement: USDC gas, ~0.5s blocks, deterministic single-block finality (Malachite BFT, no reorgs; confirmed 2026-09-25, see VERIFICATION.md). Base-fee behavior is still unverified; do not quote a fixed gwei figure.
- Chain facts (mainnet, chain ID 5042): Permit2 verified at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`, same as Ethereum. Multicall3, the CREATE2 deployer and the Safe v1.4.1 singleton and proxy factory have code at their canonical addresses on mainnet (checked 2026-10-07); their exact versions are not verified, so verify them before mainnet.
- Willingness to pay is proven: Request Finance charges $600 to $9,000/mo for crypto billing ops. No competitor (Request, Superfluid, Sablier, Diagonal) supports Arc.
- Defense: keep the on-chain pull primitive free and open-source; monetize the SaaS layer (dunning engine, webhooks, reconciliation, dashboards).

## Product definition

**Actors:** Merchant (a merchant account: the address that created its plans, whose owner acts for it and whose payout address receives USDC minus the 1% fee), Subscriber (approves a USDC allowance, gets charged per cycle), Keeper (off-chain service that triggers the pulls).

**Merchant account** (on-chain): a permanent id, the address a plan was created for. Owner: who acts for it, the account itself until handed on in two steps. Payout: where its 99% goes, the owner unless fixed elsewhere (a Safe, say).

**Plan** (on-chain, terms immutable): merchant account, price per cycle (6-decimal USDC units), cycle length (seconds, 1 day to 10 years), trial (seconds, shorter than the cycle, optional), maxFailed (PAST_DUE at that many failures, auto-pause at twice that), maxCycles (cycles billed before the subscription completes, 0 for no limit), introPrice and introCycles (a lower price for a subscription's first cycles, above 0 and below the price), transferable (whether subscriptions may move to another wallet). `retired` is the one field that changes. There is no plan name on-chain.

**Subscription:** links a subscriber to a plan. States: TRIAL, ACTIVE, PAST_DUE, PAUSED, CANCELLED, COMPLETED. Fields: subscriber, planId, start, nextChargeAt, failedAttempts, credit, chargeCount, status; plus the merchant's reference in `subscriptionRef`, and in their own mappings the billed price, the cycles billed on the current plan, the intro cycles left and a pending transfer.

## Core flows

**Subscribe.** The subscriber approves a USDC allowance to the SubscriptionManager and calls `subscribe(planId, ref)`: two transactions, which the checkout page walks them through. Or one transaction: `subscribeWithPermit2(planId, ref, permit, signature)` with an off-chain EIP-712 Permit2 signature, submitted by the subscriber themselves (the permit does not bind a plan, so it cannot be relayed safely). Billing is in advance: without a trial, subscribe pulls the first cycle and reverts if the pull fails. A retired plan takes no new subscribers. `ref` is the merchant's reference for the customer (bytes32, public, chosen by whoever subscribes).

**Charge.** The keeper calls `charge(subId)` once `block.timestamp >= nextChargeAt`; the pull pays for the cycle that starts then. `charge()` is permissionless: it can only move the subscriber's pre-approved funds to the payout of that plan's merchant account, so there is nothing to gain by calling it. The contract checks the state is chargeable (TRIAL, ACTIVE or PAST_DUE), prices the cycle (the intro price while intro cycles are left), spends proration credit first, pulls the rest via `transferFrom` (direct allowance first, Permit2 as fallback), sends 1% to the FeeRouter and 99% to the account's payout address, advances `nextChargeAt` by one cycle and emits `Charged`. The cycle that reaches a limited plan's `maxCycles` moves the subscription to COMPLETED, which is terminal. After failed attempts, or when a whole cycle passed with no charge, the next charge is instead one cycle from now: the overdue time is forgiven, as resume forgives paused time, so a successful charge never leaves the next one due and missed cycles cannot be pulled back to back. If the pull fails (allowance or balance), it increments `failedAttempts` and emits `ChargeFailed` without reverting.

**Dunning.** Failure state is on-chain. At `maxFailed` failures the subscription becomes PAST_DUE; at `2 × maxFailed` the contract auto-pauses it (PAUSED, `AutoPaused`) inside `charge()`, so the keeper never pauses anything itself. The contract enforces the schedule's gaps between recorded failures: 1 day before the second, 3 before the third, 7 before each later one (`retryGap`; a sooner failing `charge()` reverts `RetryTooSoon`), so a third party calling the permissionless `charge()` cannot compress it. Off-chain, the keeper retries on that schedule (configurable to longer gaps, never shorter). A successful charge clears the retry schedule and starts a fresh cycle from the payment (see Charge). The subscriber can resume an auto-paused subscription (the merchant cannot), which resets `failedAttempts` and the keeper's retry schedule. Merchants get Ed25519-signed webhooks for each step and notify their subscribers themselves (suggested copy in `docs/dunning-copy.md`).

**Proration.** A plan change, same merchant account only and never into a retired plan, starts the new plan immediately and bills its first cycle immediately, at its full price: intro prices stay with the plan a subscription started on. Unused paid time on the old plan becomes credit, `billedPrice * remainingSeconds / cycleSeconds` (integer math, rounded down; the remainder stays with the merchant), added to any credit already held. `billedPrice` is the price the cycle in progress was billed at, written on every billed cycle, including one paid from credit. Credit is spent first; the rest is pulled. Credit left over after a downgrade covers later cycles. Trial time was never paid for and earns no credit. Credit can never move to another merchant, and credit left at cancellation or completion is forfeited. The change restarts the cycle count on the new plan.

**Pause / cancel.** The subscriber or merchant can pause (nothing is charged while paused) or cancel (terminal; no on-chain refunds, which are merchant policy, handled off-chain). Resuming restarts billing against the subscriber's allowance, so the subscriber can resume any pause and the merchant only a pause it made itself (`pausedByMerchant`); a subscriber's pause or an auto-pause needs the subscriber. Resume is a fresh start: if `nextChargeAt` passed during the pause, it moves to the resume time, so paused cycles are never billed and an overdue cycle is forgiven (as with `changePlan`). Paid days keep running during a pause. A completed subscription cannot be paused, resumed or cancelled.

**Merchant accounts.** The owner sets a fixed payout (`setPayout`, one step, from the next collection; zero follows the owner, the manager's own address is refused) and hands the account on in two steps (`transferOwnership`, then `acceptOwnership` by the new owner). A fixed payout survives a handover. Only the current owner creates plans for the account, retires them and acts on its subscriptions. A blocklisted payout address makes the account's charges revert until a new one is set.

**Retiring.** `setPlanRetired(planId, retired)` stops new subscriptions and plan changes into the plan, or allows them again. Existing subscriptions are untouched.

**Moving a subscription.** On a transferable plan, the subscriber proposes a new wallet (`proposeTransfer`) and that wallet accepts (`acceptTransfer`, naming the current plan). Only the subscriber changes: id, ref, paid time, credit, counters and dunning state carry over, and later charges pull from the new wallet. Only the payer can agree to pay, because one allowance pays all of a wallet's Levy subscriptions.

**Invoicing.** Every `Charged` event becomes an invoice record: id, invoiceRef (`keccak256(abi.encode(subId, chargeCount))`), subscription, subscriber, merchant, amount, fee, tx hash, block, charge count. The merchant dashboard exports CSV. Cycle dates, memo references and PDF receipts are not built.

**Allowance runway.** A subscriber's allowance is one pool shared by all their Levy subscriptions. The keeper warns merchants (`allowance.low`) when it does not cover the next 2 charges of the subscriber's subscriptions, priced as they will be billed (intro cycles at the intro price, none past a limited plan's last), and the portal offers a top-up. Only direct ERC-20 allowances count; Permit2 allowances are not read, so a Permit2 subscriber is flagged low.

## Smart contracts

**SubscriptionManager** (the pull primitive, open-source):
- `createPlan(account, PlanTerms(price, cycleSeconds, trialSeconds, maxFailed, maxCycles, introPrice, introCycles, transferable)) → planId`: the caller must own `account` (`createPlan(msg.sender, ...)` needs no setup)
- `setPlanRetired(planId, retired)`: the account's owner only
- `setPayout(account, payout)`, `transferOwnership(account, newOwner)`: the account's owner only. `acceptOwnership(account)`: the proposed owner only
- `subscribe(planId, ref)`: subscriber is `msg.sender`; refuses a retired plan; without a trial, pulls the first cycle; stores `ref` in `subscriptionRef` and emits it in `Subscribed`
- `subscribeWithPermit2(planId, ref, permitSingle, signature)`: one-tx subscribe via Arc Permit2; the permit owner is `msg.sender`
- `charge(subId)`: permissionless; price the cycle, spend credit, pull, split, advance, emit, and complete a limited plan's last cycle
- `pauseSubscription(subId)` / `cancelSubscription(subId)`: subscriber or the account's owner only. `resumeSubscription(subId)`: the subscriber, or the account's owner for a pause the merchant made (`NotSubscriber` otherwise). Auto-pause at `2 × maxFailed` happens inside `charge()` and emits `AutoPaused`
- `changePlan(subId, newPlanId)`: subscriber only, same-account plans that are not retired; bills the new plan now at its full price, less proration credit; reverts with `PaymentFailed` if the pull fails
- `proposeTransfer(subId, to)`: subscriber only, on a transferable plan; zero withdraws. `acceptTransfer(subId, planId)`: the proposed wallet only, naming the current plan
- Views: `plans(id)`, `subscriptions(id)`, `subscriptionRef(id)`, `isChargeable(id)`, `lastFailedAt(id)`, `pausedByMerchant(id)`, `billedPrice(id)`, `planCycles(id)`, `introCyclesLeft(id)`, `pendingTransfer(id)`, `ownerOf(account)`, `payoutOf(account)`, `accountPayout(account)`, `pendingOwner(account)`, `retryGap(failures)`, `planCount`, `subCount`
- Events: `PlanCreated(planId, merchant, price, cycleSeconds)`, `Subscribed(subId, subscriber, planId, nextChargeAt, ref)`, `Charged(subId, amount, fee, invoiceRef, chargeCount)` (amount is what was pulled, 0 when credit covered the cycle), `ChargeFailed(subId, failedAttempts)`, `AutoPaused(subId)`, `Paused(subId)`, `Resumed(subId)`, `Cancelled(subId)`, `PlanChanged(subId, oldPlanId, newPlanId, credit)`, `PlanRetired(planId, retired)`, `Completed(subId)`, `TransferProposed(subId, from, to)`, `SubscriptionTransferred(subId, from, to)`, `PayoutChanged(account, payout)`, `OwnershipTransferStarted(account, pendingOwner)`, `OwnershipTransferred(account, previousOwner, newOwner)`

**FeeRouter:** receives the 1% at charge time and holds it until anyone calls `sweep()`, which sends the whole balance to the treasury (a Safe multisig on mainnet). Moving the treasury takes two steps, so a mistyped address cannot take over: the treasury calls `proposeTreasury(next)`, then `next` calls `acceptTreasury()`. Phase 2: split 50% buyback-and-burn LEVY / 50% staking rewards (not built).

**Invariants (fuzz-tested):** every minted unit sits in exactly one tracked account; the manager holds no funds at rest; `failedAttempts <= 2 × maxFailed`; recorded failures follow the dunning schedule's gaps; cancel and completion are terminal; no subscription is billed more than `maxCycles` times on one plan; `nextChargeAt` never falls below `start`; a successful charge never leaves the subscription chargeable; credit never exceeds the USDC the subscription paid, nor the largest plan price; a retired plan gains no subscriptions or plan changes; a subscription changes wallet only when its subscriber proposed that wallet and the wallet accepted.

## Off-chain services

- **Keeper:** two independent loops. The charge loop (every 30s) syncs events, charges due subscriptions, runs dunning retries, backs off charges that revert, and checks allowance runway; the delivery loop (every 5s) sends webhooks, so a slow merchant endpoint never delays charging. Pays its own gas in USDC. Single instance.
- **Indexer:** reads every SubscriptionManager event plus only the USDC Transfers into or out of the manager and Approvals to it, in chunks of `LEVY_LOG_CHUNK_BLOCKS`. Charge truth comes from `Charged` / `ChargeFailed`, not transfer sums; the transfer table is kept for visibility only.
- **Webhook dispatcher:** Ed25519 signature over `{timestamp}.{deliveryId}.{webhookId}.{event}.{body}`, with `X-Levy-Timestamp`, `X-Levy-Delivery`, `X-Levy-Webhook`, `X-Levy-Key-Id` and `X-Levy-Event` headers; one key signs for every merchant, so receivers verify against their own webhook id and check that `merchant` is theirs. Thirteen events: subscription.created, subscription.updated, charge.succeeded, charge.failed, dunning.started, subscription.paused, subscription.resumed, subscription.cancelled, invoice.ready, allowance.low, subscription.completed, subscription.transferred, merchant.updated. Every payload except merchant.updated carries `subId`, `merchant` and `ref`; merchant.updated carries the account's `merchant`, `owner`, `payout` and `pendingOwner`. Up to 8 deliveries in parallel, one in flight per webhook; retries at 1m, 5m, 15m, 1h, then every 6h; a delivery is dead-lettered when its next retry would pass 24h, so the last attempt is at about 19h21m. URLs must be https on port 443 at a public address (checked at registration and at connect time); at most 5 per merchant.
- **API + merchant dashboard:** Sign-In with Ethereum (24h sessions), every endpoint scoped to the signed-in address and, for merchant data, to the merchant accounts it owns now. Plans mirror the on-chain registry; merchants create and retire them from the dashboard (transactions from the owner's wallet), copy each plan's checkout link there, and manage the account's payout and ownership. Metrics: MRR normalized to 30 days, counts per status, totals, charge success rate, dunning depth. Also the subscriber list with references and allowance runway, dunning queue, invoice CSV and webhook config.
- **Customer portal:** subscriptions and invoice history; pause, resume, cancel, plan changes and moving a subscription to another wallet from the wallet, and accepting one offered to it; the allowance, with top-up and revoke. White-label is a Phase 2 premium feature.
- **Checkout page:** `/checkout.html?plan=<id>&ref=<ref>`: plan summary with intro and limited terms, approve N payments (default 12, intro payments at the intro price, at most a limited plan's payments, added to the existing allowance) and subscribe. Retired plans are refused.

## Money math (read twice before writing contracts)

- ALL accounting in **6-decimal ERC-20 USDC units** via `0x3600…0000`. Never let a native 18-decimal value into payment math. Convert at the boundary only.
- Integer arithmetic only. Division rounds down; the merchant keeps any rounding.
- The fee is 1% of the pulled amount, computed as `amount / 100` (integer division). A pull under 100 units ($0.0001) pays no fee; that is acceptable and documented.
- Compile with `evmVersion: paris` as a conservative default. Arc mainnet runs an Osaka-baseline EVM (PUSH0 works); the paris pin is harmless but no longer needed. Do not claim PUSH0 is rejected on mainnet; that was testnet-only.
- One block is final. No multi-block confirmation logic anywhere.

## Memos (live on mainnet, not yet wired into Levy)

Arc transaction memos are **live on mainnet** (verified 2026-09-25; Memo contract `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`, with `Multicall3From` at `0x522fAf9A91c41c443c66765030741e4AaCe147D0`). The September 2026 "testnet-only" note is superseded. Design: every invoice carries a `bytes32 invoiceRef`; when memos are wired in, the keeper wraps each `charge()` in the Memo contract so the payment carries invoice, subscriber and plan metadata on-chain with the real payer preserved via CALL_FROM. Until then, the reference lives in events and the indexer DB. This integration is pre-mainnet work, not MVP.

## Token economics: LEVY (Phase 2, not day one)

Phase 1 ships with fees to treasury. The token launches with traction, not before.

- **Fee split at token launch:** 1% of collected USDC; 50% market-buys and burns LEVY, 50% goes to stakers as USDC.
- **Staking tiers:** staked LEVY reduces the merchant's fee, e.g. base 1.00%, tier 1 at 0.75%, tier 2 at 0.50%. Tiers denominated in USD value of stake, rebalanced by oracle or governance vote.
- **Stake-gated premium:** white-label portal, high-volume webhooks, advanced dunning config, API rate limits.
- **Verified-employer style badge:** optional merchant bond in LEVY for a "verified biller" badge in the directory.
- Honest note: the token is a growth and value-accrual mechanism, not infrastructure. USDC-only billing works without it. Launch it when there's revenue to route through it.

## Security considerations

This is not a security product, but it holds other people's money rails. Non-negotiables:
- Reentrancy guards on every function that moves tokens (`subscribe`, `subscribeWithPermit2`, `charge`, `changePlan`).
- `transferFrom` failures are caught and recorded rather than reverting `charge()` (a failing call inside the `retryGap` window reverts `RetryTooSoon` and changes nothing); transfers out use SafeERC20.
- Access control: subscriber-or-owner pause and cancel; resume by the subscriber, or by the account's owner for the merchant's own pause; plan terms immutable; account changes by the current owner only, ownership in two steps; wallet transfers proposed by the subscriber and accepted by the new wallet only; `charge()` permissionless by design. The keeper never force-pauses; auto-pause happens inside `charge()`.
- Allowance hygiene: never request unlimited allowance in the default UX. The checkout approves N payments (N chosen by the subscriber, default 12, priced as they will be billed and never more than a limited plan's payments) on top of the existing allowance, and the portal offers a top-up when it runs low.
- Invariant fuzzing in Foundry: fee math, proration bounds, state machine transitions.
- Testnet soak: run the keeper against testnet for at least a week of simulated cycles before mainnet.

Open issues and the self-review are in `SECURITY_REVIEW.md`; the math audit is in `FEE_MATH_AUDIT.md`.

## Build phases

**M1: Contracts.** SubscriptionManager + FeeRouter in Foundry with unit and invariant tests, and a deploy script. Done; the testnet deploy moved to M4.

**M2: Keeper + indexer.** Keeper service, indexer, dunning engine with retry schedule. Done (tested against anvil; testnet run is part of M4).

**M3: SaaS layer.** Merchant dashboard, customer portal, checkout, Ed25519 webhook dispatcher, invoice records and CSV export, wallet sign-in. Done.

**M4: Hardening + mainnet.** Testnet deploy and soak, verification checklist cleared (Permit2 flow on Arc, treasury multisig), open security items addressed, external audit, mainnet deploy with the treasury multisig. Acceptance: first real USDC subscription billed on mainnet.

**M5: Token (post-traction).** LEVY, staking tiers, buyback-and-burn router, premium gating. Only after real fee revenue exists.

## Open verification checklist (clear before mainnet)

- [x] Transaction memos on mainnet: confirmed live 2026-09-25 (VERIFICATION.md)
- [x] Finality assumptions: single-block deterministic, ~0.5s, no reorgs
- [x] PUSH0 behavior: Osaka EVM; paris pin kept as harmless default
- [x] Permit2 mainnet address: canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`; subscribeWithPermit2 built against it
- [ ] Permit2 end to end against Arc (subscribe exercised on testnet by soak wallet S5, 2026-10-07; recurring charges still to confirm in the soak)
- [ ] FeeRouter treasury multisig signers set
- [x] Dunning copy reviewed (revised 2026-09-25 to match actual dunning behaviour; see docs/dunning-copy.md)
- [ ] Thin-liquidity assumption documented for launch comms

## Repo layout

```
levy/
├── src/                # Foundry: SubscriptionManager, FeeRouter, IPermit2
├── script/             # Deploy.s.sol (Arc testnet / mainnet)
├── test/               # 117 tests: 104 unit (incl. deploy script), 13 invariants
├── foundry.toml
├── FEE_MATH_AUDIT.md   # fee + proration math audit
├── SECURITY_REVIEW.md  # adversarial self-review and open issues
├── keeper/             # indexer, charge loop, dunning, webhook delivery, allowance checks
├── api/                # Fastify API + merchant dashboard, customer portal, checkout
├── ops/                # Dockerfiles, docker-compose, systemd unit, .env example, monitoring runbook, multisig plan
├── site/               # getlevy.xyz landing page and whitepaper (static)
├── docs/               # merchant guide, dunning copy
├── SPEC.md             # this doc
└── VERIFICATION.md     # pre-mainnet fact checks with sources
```

## Name check

LEVY ticker: clean per 2026-09-24 checks (one brand flag: Starknet "Due" app, one letter off, different category; noted, not blocking).

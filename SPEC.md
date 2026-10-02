# LEVY: Subscription Billing on Arc

**Status:** living build doc, updated 2026-09-26. Contracts, keeper, API, merchant dashboard, customer portal and checkout are built and tested. The contracts are deployed on Arc testnet for the M4 soak (addresses in README, Deployments); nothing is on mainnet. Verified chain facts are in `VERIFICATION.md`.
**One-liner:** Stripe Billing for Arc. Merchants create plans, subscribers approve a USDC allowance once, Levy pulls USDC every cycle with dunning, proration, webhooks and invoice records built in.

## Why this, why Arc, why now

- Circle names software billing a target Arc use case. Nothing live fills it; only testnet toys exist.
- Arc is purpose-built for money movement: USDC gas, ~0.5s blocks, deterministic single-block finality (Malachite BFT, no reorgs; confirmed 2026-09-25, see VERIFICATION.md). Base-fee behavior is still unverified; do not quote a fixed gwei figure.
- Chain facts (mainnet, chain ID 5042): Permit2 verified at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`, same as Ethereum. Multicall3, CREATE2 deployer and Safe v1.4.1 at canonical addresses are still unconfirmed; verify before mainnet.
- Willingness to pay is proven: Request Finance charges $600 to $9,000/mo for crypto billing ops. No competitor (Request, Superfluid, Sablier, Diagonal) supports Arc.
- Defense: keep the on-chain pull primitive free and open-source; monetize the SaaS layer (dunning engine, webhooks, reconciliation, dashboards).

## Product definition

**Actors:** Merchant (creates plans, receives USDC minus the 1% fee), Subscriber (approves a USDC allowance, gets charged per cycle), Keeper (off-chain service that triggers the pulls).

**Plan** (on-chain, immutable): merchant, price per cycle (6-decimal USDC units), cycle length (seconds, 1 day to 10 years), trial (seconds, shorter than the cycle, optional), graceSeconds (informational only; the retry schedule lives in the keeper), maxFailed (PAST_DUE at that many failures, auto-pause at twice that). There is no plan name on-chain.

**Subscription:** links a subscriber to a plan. States: TRIAL, ACTIVE, PAST_DUE, PAUSED, CANCELLED. Fields: subscriber, planId, start, nextChargeAt, failedAttempts, credit, chargeCount, status; plus the merchant's reference in `subscriptionRef`.

## Core flows

**Subscribe.** The subscriber approves a USDC allowance to the SubscriptionManager and calls `subscribe(planId, ref)`: two transactions, which the checkout page walks them through. Or one transaction: `subscribeWithPermit2(planId, ref, permit, signature)` with an off-chain EIP-712 Permit2 signature, submitted by the subscriber themselves (the permit does not bind a plan, so it cannot be relayed safely). Billing is in advance: without a trial, subscribe pulls the first cycle and reverts if the pull fails. `ref` is the merchant's reference for the customer (bytes32, public, chosen by whoever subscribes).

**Charge.** The keeper calls `charge(subId)` once `block.timestamp >= nextChargeAt`; the pull pays for the cycle that starts then. `charge()` is permissionless: it can only move the subscriber's pre-approved funds to that plan's merchant, so there is nothing to gain by calling it. The contract checks the state is chargeable (TRIAL, ACTIVE or PAST_DUE), spends proration credit first, pulls the rest via `transferFrom` (direct allowance first, Permit2 as fallback), sends 1% to the FeeRouter and 99% to the merchant, advances `nextChargeAt` by one cycle and emits `Charged`. If the pull fails (allowance or balance), it increments `failedAttempts` and emits `ChargeFailed` without reverting.

**Dunning.** Failure state is on-chain. At `maxFailed` failures the subscription becomes PAST_DUE; at `2 × maxFailed` the contract auto-pauses it (PAUSED, `AutoPaused`) inside `charge()`, so the keeper never pauses anything itself. The contract records at most one failure per subscription per day (`MIN_RETRY_INTERVAL`; a sooner failing `charge()` reverts `RetryTooSoon`), so a third party calling the permissionless `charge()` cannot compress the schedule. Off-chain, the keeper retries 1, 3 and then 7 days after each failure (then every 7 days; configurable). A successful charge clears the retry schedule. The merchant or subscriber can resume a paused subscription, which resets `failedAttempts` and the keeper's retry schedule. Merchants get Ed25519-signed webhooks for each step and notify their subscribers themselves (suggested copy in `docs/dunning-copy.md`).

**Proration.** A plan change, same merchant only, starts the new plan immediately and bills its first cycle immediately. Unused paid time on the old plan becomes credit, `price * remainingSeconds / cycleSeconds` (integer math, rounded down; the remainder stays with the merchant), added to any credit already held. Credit is spent first; the rest is pulled. Credit left over after a downgrade covers later cycles. Trial time was never paid for and earns no credit. Credit can never move to another merchant.

**Pause / cancel.** The subscriber or merchant can pause (nothing is charged while paused) or cancel (terminal; no on-chain refunds, which are merchant policy, handled off-chain). Resume is a fresh start: if `nextChargeAt` passed during the pause, it moves to the resume time, so paused cycles are never billed and an overdue cycle is forgiven (as with `changePlan`). Paid days keep running during a pause.

**Invoicing.** Every `Charged` event becomes an invoice record: id, invoiceRef (`keccak256(subId, chargeCount)`), subscription, subscriber, merchant, amount, fee, tx hash, block, charge count. The merchant dashboard exports CSV. Cycle dates, memo references and PDF receipts are not built.

**Allowance runway.** A subscriber's allowance is one pool shared by all their Levy subscriptions. The keeper warns merchants (`allowance.low`) when it covers fewer than 2 more rounds of the subscriber's charges, and the portal offers a top-up. Only direct ERC-20 allowances count; Permit2 allowances are not read, so a Permit2 subscriber is flagged low.

## Smart contracts

**SubscriptionManager** (the pull primitive, open-source):
- `createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed) → planId`
- `subscribe(planId, ref)`: subscriber is `msg.sender`; without a trial, pulls the first cycle; stores `ref` in `subscriptionRef` and emits it in `Subscribed`
- `subscribeWithPermit2(planId, ref, permitSingle, signature)`: one-tx subscribe via Arc Permit2; the permit owner is `msg.sender`
- `charge(subId)`: permissionless; spend credit, pull, split, advance, emit
- `pauseSubscription(subId)` / `resumeSubscription(subId)` / `cancelSubscription(subId)`: subscriber or merchant only. Auto-pause at `2 × maxFailed` happens inside `charge()` and emits `AutoPaused`
- `changePlan(subId, newPlanId)`: subscriber only, same-merchant plans only; bills the new plan now, less proration credit; reverts with `PaymentFailed` if the pull fails
- Views: `plans(id)`, `subscriptions(id)`, `subscriptionRef(id)`, `isChargeable(id)`, `planCount`, `subCount`
- Events: `PlanCreated(planId, merchant, price, cycleSeconds)`, `Subscribed(subId, subscriber, planId, nextChargeAt, ref)`, `Charged(subId, amount, fee, invoiceRef, chargeCount)` (amount is what was pulled, 0 when credit covered the cycle), `ChargeFailed(subId, failedAttempts)`, `AutoPaused(subId)`, `Paused(subId)`, `Resumed(subId)`, `Cancelled(subId)`, `PlanChanged(subId, oldPlanId, newPlanId, credit)`

**FeeRouter:** receives the 1% at charge time and holds it until anyone calls `sweep()`, which sends the whole balance to the treasury (a Safe multisig on mainnet). Phase 2: split 50% buyback-and-burn LEVY / 50% staking rewards (not built).

**Invariants (fuzz-tested):** every minted unit sits in exactly one tracked account; the manager holds no funds at rest; `failedAttempts <= 2 × maxFailed`; recorded failures are at least a day apart; cancel is terminal; `nextChargeAt` never falls below `start`; credit never exceeds the USDC the subscription paid, nor the largest plan price.

## Off-chain services

- **Keeper:** two independent loops. The charge loop (every 30s) syncs events, charges due subscriptions, runs dunning retries, backs off charges that revert, and checks allowance runway; the delivery loop (every 5s) sends webhooks, so a slow merchant endpoint never delays charging. Pays its own gas in USDC. Single instance.
- **Indexer:** reads every SubscriptionManager event plus only the USDC Transfers into or out of the manager and Approvals to it, in chunks of `LEVY_LOG_CHUNK_BLOCKS`. Charge truth comes from `Charged` / `ChargeFailed`, not transfer sums; the transfer table is kept for visibility only.
- **Webhook dispatcher:** Ed25519 signature over `{timestamp}.{deliveryId}.{event}.{body}`, with `X-Levy-Timestamp`, `X-Levy-Delivery`, `X-Levy-Key-Id` and `X-Levy-Event` headers. Ten events: subscription.created, subscription.updated, charge.succeeded, charge.failed, dunning.started, subscription.paused, subscription.resumed, subscription.cancelled, invoice.ready, allowance.low. Every payload carries `subId`, `merchant` and `ref`. Up to 8 deliveries in parallel, one in flight per webhook; retries at 1m, 5m, 15m, 1h, 6h; dead-letter after 24h. URLs must be https on port 443 at a public address (checked at registration and at connect time); at most 5 per merchant.
- **API + merchant dashboard:** Sign-In with Ethereum (24h sessions), every endpoint scoped to the signed-in address. Plans mirror the on-chain registry; merchants create them from the dashboard (a `createPlan` transaction from their wallet) and copy each plan's checkout link there. Metrics: MRR normalized to 30 days, counts per status, totals, charge success rate, dunning depth. Also the subscriber list with references and allowance runway, dunning queue, invoice CSV and webhook config.
- **Customer portal:** subscriptions and invoice history; pause, resume, cancel and plan changes from the wallet; the allowance, with top-up and revoke. White-label is a Phase 2 premium feature.
- **Checkout page:** `/checkout.html?plan=<id>&ref=<ref>`: plan summary, approve N cycles (default 12, added to the existing allowance) and subscribe.

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
- `transferFrom` failures are caught and recorded, never allowed to revert `charge()`; transfers out use SafeERC20.
- Access control: subscriber-or-merchant pause, resume and cancel; plans immutable; `charge()` permissionless by design. The keeper never force-pauses; auto-pause happens inside `charge()`.
- Allowance hygiene: never request unlimited allowance in the default UX. The checkout approves `price × N` cycles (N chosen by the subscriber, default 12) on top of the existing allowance, and the portal offers a top-up when it runs low.
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
- [ ] Permit2 end to end against Arc (Foundry-tested against a mock only)
- [ ] FeeRouter treasury multisig signers set
- [x] Dunning copy reviewed (revised 2026-09-25 to match actual dunning behaviour; see docs/dunning-copy.md)
- [ ] Thin-liquidity assumption documented for launch comms

## Repo layout

```
levy/
├── src/                # Foundry: SubscriptionManager, FeeRouter, IPermit2
├── script/             # Deploy.s.sol (Arc testnet / mainnet)
├── test/               # 61 tests: 53 unit (incl. deploy script), 8 invariants
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

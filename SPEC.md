# LEVY — Subscription Billing on Arc Mainnet

**Status:** Living build doc — 2026-09-25. M1 (contracts), M2 (keeper), M3 (webhooks/API/dashboards) complete; Permit2 subscribe path implemented. See VERIFICATION.md for cleared pre-mainnet facts.
**One-liner:** Stripe Billing for Arc. Merchants create plans, subscribers approve once, Levy pulls USDC every cycle with dunning, proration, webhooks, and invoicing built in.

## Why this, why Arc, why now

- Circle names software billing a target Arc use case. Nothing live fills it; only testnet toys exist.
- Arc is purpose-built for money movement: USDC gas, ~0.5s blocks, deterministic single-block finality (Malachite BFT, no reorgs — confirmed 2026-09-25, see VERIFICATION.md). Base-fee behavior is still unverified; do not quote a fixed gwei figure.
- Chain facts (mainnet, chain ID 5042): Permit2 verified on Arc mainnet at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`, same as Ethereum. Multicall3, CREATE2 deployer, Safe v1.4.1 at canonical addresses — still unconfirmed, verify before mainnet.
- Willingness to pay is proven: Request Finance charges $600–$9,000/mo for crypto billing ops. No competitor (Request, Superfluid, Sablier, Diagonal) supports Arc.
- Defense: keep the on-chain pull primitive free and open-source; monetize the SaaS layer (dunning engine, webhooks, reconciliation, dashboards).

## Product definition

**Actors:** Merchant (creates plans, receives USDC minus 1% fee), Subscriber (approves allowance once, gets charged per cycle), Keeper (off-chain service triggering pulls).

**Plan:** merchant-defined. Fields: name, price per cycle (6-decimal USDC units), cycle length (seconds; presets: weekly, monthly, quarterly, yearly), trial period (seconds, optional), grace period for dunning (seconds, default 3 days), max failed attempts before auto-pause.

**Subscription:** links subscriber to plan. States: TRIAL, ACTIVE, PAST_DUE, PAUSED, CANCELLED. Fields: subscriber, plan, start, nextChargeAt, allowanceGranted, failedAttempts.

## Core flows

**Subscribe.** Subscriber grants USDC allowance to the SubscriptionManager via direct `approve()` then `subscribe()` — two transactions. Or one transaction: `subscribeWithPermit2()` with an off-chain EIP-712 Permit2 signature, submitted by the subscriber (the permit does not bind a plan, so it cannot be relayed safely). Uses Arc's Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Billing is in advance: without a trial, subscribe pulls the first cycle and reverts if the pull fails.

**Charge.** Keeper calls `charge(subscriptionId)` when `block.timestamp >= nextChargeAt`; the pull pays for the cycle that starts then. `charge()` is permissionless — the pull can only move the subscriber's pre-approved funds to the correct merchant, so there is nothing to gain by calling it. Contract checks state is chargeable (TRIAL, ACTIVE, or PAST_DUE), pulls `price` via `transferFrom` (direct allowance first, Permit2 `transferFrom` fallback), splits 1% to FeeRouter and 99% to merchant, advances `nextChargeAt` by cycle length, emits `Charged`. If the pull fails (allowance/balance), increments `failedAttempts`, emits `ChargeFailed`, and the dunning engine takes over off-chain.

**Dunning.** Failure state is managed on-chain by the contract, not by the keeper. When `failedAttempts` reaches the plan's `maxFailed`, the subscription moves to `PAST_DUE`. At `2 × maxFailed` failures the contract auto-pauses it (`PAUSED`); the keeper never needs to call `pauseSubscription()` for dunning. Off-chain, the keeper watches `ChargeFailed` and retries on a schedule (default day 1, 3, 7; configurable). A successful retry clears the dunning schedule. Merchant (or subscriber) can resume a paused subscription, which resets `failedAttempts` and the keeper's retry schedule; subscriber notifications go out as Ed25519-signed webhooks.

**Proration.** Plan change mid-cycle, same merchant only: the new plan starts immediately and its first cycle is billed immediately. Unused paid time on the old plan becomes credit, `price * remainingSeconds / cycleSeconds` (integer math, 6-decimal units, round down; remainder stays with merchant), added to any credit already held. Credit is spent first; the rest is pulled. Credit left over after a downgrade covers later cycles. Trial time was never paid for and earns no credit. Credit can never move to another merchant.

**Pause / cancel.** Subscriber or merchant can pause (no charges while paused) or cancel (terminal; no on-chain refunds — refunds are merchant policy, handled off-chain). `cancelSubscription()` emits `Cancelled`. Resume is a fresh start: if `nextChargeAt` passed during the pause, it moves to the resume time, so paused cycles are never billed and an overdue cycle is forgiven (as with `changePlan`). Paid days keep running during a pause.

**Invoicing.** Every `Charged` event generates an invoice record: invoice ID, subscription, cycle dates, amount, fee, tx hash, memo reference (see Memos below). Merchant dashboard exports CSV; PDF receipts are post-MVP.

## Smart contracts

**SubscriptionManager** (the pull primitive, open-source):
- `createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed) → planId`
- `subscribe(planId)` — requires allowance; subscriber is `msg.sender`; handles trial → sets first `nextChargeAt`
- `subscribeWithPermit2(planId, permitSingle, signature)`: one-tx subscribe via Arc Permit2; the permit owner is `msg.sender`
- `charge(subscriptionId)` — permissionless; pull, split, advance, emit
- `pauseSubscription(subId)` / `resumeSubscription(subId)` / `cancelSubscription(subId)` — subscriber or merchant only. The keeper never calls these for dunning; auto-pause on `2 × maxFailed` failures happens inside `charge()` and emits `AutoPaused`
- `changePlan(subscriptionId, newPlanId)`: subscriber only, same-merchant plans only; bills the new plan now, less proration credit
- Events: `PlanCreated`, `Subscribed`, `Charged(subId, amount, fee, invoiceRef, chargeCount)`, `ChargeFailed(subId, attempts)`, `AutoPaused`, `Paused`, `Resumed`, `Cancelled`, `PlanChanged`

**FeeRouter:** receives 1% at charge time. Phase 1: forwards to treasury multisig. Phase 2: splits 50% buyback-and-burn LEVY / 50% staking rewards.

**Invariants (test these):** total pulled == merchant received + fees, always; `nextChargeAt` only moves on a successful pull, a paid plan change, or a resume, and never falls below `start`; no charge when CANCELLED; proration credit never exceeds the USDC that subscription actually paid, and never moves between merchants; keeper cannot charge for another merchant's plan (merchant-scoped keeper auth or fully permissionless `charge` — permissionless is simpler and safe since pulls only move the subscriber's approved funds to the right merchant).

## Off-chain services

- **Keeper:** watches `nextChargeAt` across subscriptions, submits `charge()` txs. Pays its own gas in USDC (small per charge; base-fee behavior still unverified). Single binary to start; later: distributed keepers.
- **Indexer:** tracks subscriptions, charges, invoices. MUST dedupe EIP-7708 double-counting: the USDC precompile emits Transfer events for native movements, so naive ERC-20 log indexing double-counts. Index from the system-emitter stream and dedupe by tx hash.
- **Webhook dispatcher:** Ed25519-signed payloads to merchant endpoints. Events: subscription.created, subscription.updated, charge.succeeded, charge.failed, dunning.started, subscription.paused, subscription.resumed, subscription.cancelled, invoice.ready, allowance.low (keeper-generated when a subscriber's allowance covers fewer than 2 more rounds). Retry with exponential backoff; dead-letter after 24h.
- **API + dashboard (merchant):** plan CRUD, subscriber list, MRR/churn metrics, dunning queue, invoice export, webhook config.
- **Customer portal:** subscriber view — active subscriptions, pause/cancel, update allowance, invoice history. White-label is a Phase 2 premium feature.

## Money math (read twice before writing contracts)

- ALL accounting in **6-decimal ERC-20 USDC units** via `0x3600…0000`. Never let a native 18-decimal value into payment math. Convert at the boundary only.
- Integer arithmetic only. Division rounds down; document who keeps dust (merchant).
- Fee is exactly 1% of the pulled amount, computed as `amount / 100` (integer division). On a $1.00 pull the fee is $0.01; dust below $0.01 rounds to zero fee — acceptable, documented.
- Compile with `evmVersion: paris` as a conservative default. Arc mainnet runs an Osaka-baseline EVM (PUSH0 works); the paris pin is no longer load-bearing, but it is harmless. Do not claim PUSH0 is rejected on mainnet — that was testnet-only.
- One block is final. No multi-block confirmation logic anywhere.

## Memos (live on mainnet, not yet wired into Levy)

Arc transaction memos are **live on mainnet** (verified 2026-09-25; Memo contract `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`, with `Multicall3From` at `0x522fAf9A91c41c443c66765030741e4AaCe147D0`). The September 2026 "testnet-only" note is superseded. Design: every invoice carries a `bytes32 invoiceRef`; when memos are wired in, the keeper wraps each `charge()` in the Memo contract so the payment carries invoice/subscriber/plan metadata on-chain with the real payer preserved via CALL_FROM. Until then, the reference lives in events + the indexer DB. This integration is pre-mainnet work, not MVP.

## Token economics — LEVY (Phase 2, not day one)

Phase 1 ships with fees to treasury. The token launches with traction, not before.

- **Fee split at token launch:** 1% of collected USDC → 50% market-buys and burns LEVY, 50% to stakers as USDC.
- **Staking tiers:** staked LEVY reduces the merchant's fee — e.g. base 1.00%, tier 1 → 0.75%, tier 2 → 0.50%. Tiers denominated in USD value of stake, rebalanced by oracle or governance vote.
- **Stake-gated premium:** white-label portal, high-volume webhooks, advanced dunning config, API rate limits.
- **Verified-employer style badge:** optional merchant bond in LEVY for a "verified biller" badge in the directory.
- Honest note: the token is a growth and value-accrual mechanism, not infrastructure. USDC-only billing works without it. Launch it when there's revenue to route through it.

## Security considerations

This is not a security product, but it holds other people's money rails. Non-negotiables:
- Reentrancy guards on `charge()` (it calls an external token contract mid-flow).
- `transferFrom` return-value checks; handle non-standard return behavior defensively.
- Access control: subscriber-or-merchant pause/cancel; plans immutable (no edits); `charge()` permissionless by design (pulls only move the subscriber's pre-approved funds to the right merchant). The keeper never force-pauses — dunning auto-pause happens inside `charge()` at `2 × maxFailed` failures.
- Allowance hygiene: never request unlimited allowance in the default UX — request `price × N cycles` (N merchant-configurable, default 12) and surface re-approval in the portal.
- Invariant fuzzing in Foundry: fee math, proration bounds, state machine transitions.
- Testnet soak: run the keeper against testnet for at least a week of simulated cycles before mainnet.

## Build phases

**M1 — Contracts (week 1).** SubscriptionManager + FeeRouter in Foundry. Full unit + invariant tests. Deploy to Arc testnet. Acceptance: 100% of invariant tests pass; subscribe → charge → cancel cycle works on testnet.

**M2 — Keeper + indexer (week 2).** Keeper service, EIP-7708-deduped indexer, dunning engine with retry schedule. Acceptance: failed payments trigger the full dunning sequence on testnet; indexer balances match chain state exactly.

**M3 — SaaS layer (week 3).** Merchant dashboard, customer portal, Ed25519 webhook dispatcher, invoice records + CSV export. Acceptance: a non-technical user can create a plan, subscribe, get charged, receive a webhook, and export invoices.

**M4 — Hardening + mainnet (week 4).** Testnet soak, docs, verification checklist cleared (memos status, Permit2 mainnet flow, fee math audit pass), mainnet deploy with treasury multisig. Acceptance: first real USDC subscription billed on mainnet.

**M5 — Token (post-traction).** LEVY, staking tiers, buyback-and-burn router, premium gating. Only after real fee revenue exists.

## Open verification checklist (clear before mainnet)

- [x] Transaction memos on mainnet — confirmed live 2026-09-25 (VERIFICATION.md)
- [x] Finality assumptions — confirmed: single-block deterministic, ~0.5s, no reorgs
- [x] PUSH0 behavior — Osaka EVM; paris pin kept as harmless default
- [x] Permit2 mainnet address: canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`; subscribeWithPermit2 built against it
- [ ] Permit2 end-to-end against Arc mainnet (anvil-tested only)
- [ ] FeeRouter treasury multisig signers set
- [x] Dunning copy reviewed (no banned-word issues; see docs/dunning-copy.md)
- [ ] Thin-liquidity assumption documented for launch comms

## Repo layout

```
levy/
├── src/                # Foundry: SubscriptionManager, FeeRouter, IPermit2
├── script/             # Deploy.s.sol (Arc testnet / mainnet)
├── test/               # unit + invariant tests (50)
├── foundry.toml
├── FEE_MATH_AUDIT.md   # fee + proration math audit
├── SECURITY_REVIEW.md  # adversarial pre-audit self-review
├── keeper/             # charge scheduler + dunning engine + webhook dispatcher
├── api/                # Fastify REST API + static merchant dashboard + customer portal
├── ops/                # docker-compose, systemd, monitoring runbook, multisig plan
├── site/               # getlevy.xyz landing page (static)
├── docs/               # merchant guide, dunning copy
├── SPEC.md             # this doc
└── VERIFICATION.md     # pre-mainnet fact checks with sources
```

## Name check

LEVY ticker: clean per 2026-09-24 checks (one brand flag: Starknet "Due" app, one letter off, different category — noted, not blocking).

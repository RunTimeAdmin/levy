# Levy — Subscription Billing on Arc

Pull-based USDC subscription billing for Arc mainnet. Merchants define plans, subscribers approve once, and a keeper triggers per-cycle pulls. Dunning, proration, webhooks, and invoicing are built in. The protocol takes a 1% fee on collected payments.

**Status:** M1 complete. Contracts written, 21 tests green (20 unit + 256-run invariant suite). Not yet deployed. Not audited.

## Contracts

| Contract | Purpose |
|---|---|
| `src/SubscriptionManager.sol` | Plan registry, subscription lifecycle, permissionless `charge()`, proration, dunning state |
| `src/FeeRouter.sol` | Collects the 1% fee. Phase 1 forwards to treasury; Phase 2 splits to buyback-and-burn / staking |

### How charging works

1. Merchant calls `createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed)`. Price is immutable; repricing means a new plan.
2. Subscriber calls `subscribe(planId)` after granting an allowance (direct `approve` or a Permit2 signature).
3. Anyone calls `charge(subId)` once `block.timestamp >= nextChargeAt`. The contract pulls via `transferFrom`, routes 99% to the merchant and 1% to the FeeRouter, advances the cycle, and emits `Charged` with an invoice reference. The call is permissionless by design: it can only move the subscriber's pre-approved funds to the correct merchant.
4. Failed pulls never revert. The failure is recorded on-chain, the subscription goes `PAST_DUE` at `maxFailed` attempts and auto-pauses at 2x, and the off-chain dunning engine retries on a schedule.

### Money math

- All amounts are 6-decimal USDC units through the ERC-20 interface (`0x3600...0000`). Native 18-decimal values never enter payment logic.
- Integer arithmetic only. The fee is `amount / 100`, rounded down; sub-cent dust stays with the merchant.
- Proration credit from a mid-cycle plan change applies to the next charge. Excess credit carries forward, and credit survives failed pulls.

### Invariants (fuzz-tested)

- Conservation: every minted unit sits in exactly one tracked account.
- `failedAttempts <= 2 * maxFailed` for every subscription.
- Cancel is terminal: `chargeCount` never moves after cancellation.
- `nextChargeAt` never moves backwards.
- The manager holds no funds at rest: every pull is fully split in the same transaction.

## Development

Requires [Foundry](https://getfoundry.sh/).

```bash
forge build
forge test
```

`foundry.toml` pins `evm_version = "paris"`. Arc rejects `PUSH0` (Shanghai and later), so this is mandatory, not stylistic.

## Deployment notes (Arc mainnet)

- Chain ID 5042, RPC `https://rpc.mainnet.arc.io`.
- USDC is the gas token; keeper operating costs are trivial at the fixed 20 gwei base fee.
- One block is final; no confirmation-depth logic anywhere.
- Transaction memos are testnet-only as of 2026-09-10. Invoicing keys off `Charged` events until memos land on mainnet.
- The indexer must dedupe EIP-7708 double-emitted Transfer events or it will double-count volume.

## Roadmap

- **M1:** contracts + tests (done)
- **M2:** keeper service, deduped indexer, dunning engine
- **M3:** merchant dashboard, customer portal, signed webhooks, invoicing
- **M4:** testnet soak, mainnet deploy
- **M5:** LEVY token — fee split to buyback-and-burn / staking, staking fee-tier discounts, premium feature gating

## License

MIT

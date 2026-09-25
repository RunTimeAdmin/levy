# Levy — Subscription Billing on Arc

Pull-based USDC subscription billing for Arc mainnet. Merchants define plans, subscribers approve once, and a keeper triggers per-cycle pulls. The protocol takes a 1% fee on collected payments.

**Status:** M1 (contracts) and M2 (keeper + dunning engine) complete. Contracts: 21 tests green (20 unit + 256-run invariant suite). Keeper: 13 tests green (10 unit + 3 anvil integration). Not yet deployed. Not audited. Webhooks, invoicing, and dashboards are M3 scope, not built.

## Contracts

| Contract | Purpose |
|---|---|
| `src/SubscriptionManager.sol` | Plan registry, subscription lifecycle, permissionless `charge()`, proration, on-chain dunning state |
| `src/FeeRouter.sol` | Collects the 1% fee. Phase 1 forwards to treasury; Phase 2 splits to buyback-and-burn / staking |

### How charging works

1. Merchant calls `createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed)`. Price is immutable; repricing means a new plan.
2. Subscriber calls `subscribe(planId)` after granting a direct ERC-20 `approve` allowance. (A Permit2 signature path is proposed, not implemented.)
3. Anyone calls `charge(subId)` once `block.timestamp >= nextChargeAt`. The contract pulls via `transferFrom`, routes 99% to the merchant and 1% to the FeeRouter, advances the cycle, and emits `Charged`. The call is permissionless by design: it can only move the subscriber's pre-approved funds to the correct merchant.
4. Failed pulls never revert. The failure is recorded on-chain (`ChargeFailed`), the subscription goes `PAST_DUE` at `maxFailed` attempts and auto-pauses at `2x`, and the off-chain keeper retries on a dunning schedule (default day 1, 3, 7).

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

## Keeper

`keeper/` — TypeScript service (viem + SQLite) that runs charge cycles: syncs events, calls `charge()` on due subscriptions, retries failures on the dunning backoff. See `keeper/README.md` for setup and operational notes.

```bash
cd keeper && npm install && npm test
```

## Development

Requires [Foundry](https://getfoundry.sh/) for contracts, Node 24 for the keeper.

```bash
forge build
forge test
```

`foundry.toml` pins `evm_version = "paris"`. (Whether Arc mainnet requires this is a pre-mainnet verification item; paris is the conservative choice until confirmed.)

## Deployment notes (Arc mainnet) — verify before deploy

- Chain ID 5042, RPC `https://rpc.mainnet.arc.io`.
- USDC is the gas token. Published fee/finality figures for Arc (e.g. fixed base fee, sub-second finality) are **unconfirmed** — verify against mainnet before relying on them for keeper economics or confirmation logic.
- Transaction memos: confirm mainnet availability before building invoicing on them. Invoicing keys off `Charged` events until then.
- Pre-mainnet checklist: PUSH0 behavior, Permit2 mainnet flow, treasury multisig, finality assumptions, production fee math.

## Roadmap

- **M1:** contracts + tests (done)
- **M2:** keeper service, deduped indexer, dunning engine (done)
- **M3:** merchant dashboard, customer portal, signed webhooks, invoicing
- **M4:** testnet soak, mainnet deploy
- **M5:** LEVY token — fee split to buyback-and-burn / staking, staking fee-tier discounts, premium feature gating

## License

MIT

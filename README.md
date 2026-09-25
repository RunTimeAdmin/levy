# Levy — Subscription Billing on Arc

Pull-based USDC subscription billing for Arc mainnet. Merchants define plans, subscribers approve once, and a keeper triggers per-cycle pulls. The protocol takes a 1% fee on collected payments.

**Status:** M1 (contracts), M2 (keeper + dunning), M3 (webhooks + API + dashboards) complete, plus Permit2 subscribe path. Contracts: 50 tests green (43 unit + 7 invariants; CI fuzzes invariants at 1000 runs x depth 40). Keeper: 53 tests green. API: 32 tests green. Not yet deployed. Not audited.

## Contracts

| Contract | Purpose |
|---|---|
| `src/SubscriptionManager.sol` | Plan registry, subscription lifecycle, permissionless `charge()`, proration, on-chain dunning state |
| `src/FeeRouter.sol` | Collects the 1% fee. Phase 1 forwards to treasury; Phase 2 splits to buyback-and-burn / staking |

### How charging works

1. Merchant calls `createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed)`. Price is immutable; repricing means a new plan.
2. Subscriber calls `subscribe(planId)` after granting a direct ERC-20 `approve` allowance, or `subscribeWithPermit2(planId, ...)` with an off-chain Permit2 signature (one transaction, submitted by the subscriber). Uses Arc's Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Billing is in advance: without a trial, the first cycle is pulled at subscribe, and the subscribe reverts if that pull fails.
3. Anyone calls `charge(subId)` once `block.timestamp >= nextChargeAt`, paying for the cycle that starts then. The contract pulls via `transferFrom`, routes 99% to the merchant and 1% to the FeeRouter, advances the cycle, and emits `Charged`. The call is permissionless by design: it can only move the subscriber's pre-approved funds to the correct merchant.
4. Failed pulls never revert. The failure is recorded on-chain (`ChargeFailed`), the subscription goes `PAST_DUE` at `maxFailed` attempts and auto-pauses at `2x`, and the off-chain keeper retries on a dunning schedule (default day 1, 3, 7). Resuming a paused subscription is a fresh start: paused cycles are never billed, billing restarts at the resume if the charge date passed, and the failure count resets.

### Money math

- All amounts are 6-decimal USDC units through the ERC-20 interface (`0x3600...0000`). Native 18-decimal values never enter payment logic.
- Integer arithmetic only. The fee is `amount / 100`, rounded down; sub-cent dust stays with the merchant.
- A plan change (same merchant only) starts the new plan now and bills its first cycle now. Unused paid time on the old plan is credited against that bill; trial time earns no credit. Excess credit carries forward, and credit survives failed pulls.

### Invariants (fuzz-tested)

- Conservation: every minted unit sits in exactly one tracked account.
- `failedAttempts <= 2 * maxFailed` for every subscription.
- Cancel is terminal: `chargeCount` never moves after cancellation.
- `nextChargeAt` never falls below the subscription's start. (It can move earlier on a switch to a shorter-cycle plan, which bills the new cycle immediately.)
- Credit is backed: a subscription never holds more credit than the USDC it has paid.
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
FOUNDRY_PROFILE=ci forge test   # deeper invariant fuzzing, as CI runs it
```

CI (`.github/workflows/ci.yml`) runs the contract tests, keeper and API typechecks and tests, and fails if `keeper/abi/*.json` no longer matches the contracts. After changing a contract, regenerate with `forge inspect <Contract> abi --json > keeper/abi/<Contract>.json` (and `bytecode` into the `.bin`).

`foundry.toml` pins `evm_version = "paris"`. Arc mainnet runs an Osaka EVM, so this is not required; paris stays as a harmless conservative default (see `VERIFICATION.md` §2).

## Deploy

`script/Deploy.s.sol` deploys FeeRouter and SubscriptionManager and prints the keeper's `.env` lines. It refuses to deploy unless USDC and Permit2 have code at their addresses and USDC reports 6 decimals, and on mainnet unless the treasury is a contract (the Safe from `ops/treasury-multisig.md`).

```bash
export DEPLOYER_PRIVATE_KEY=0x...   # pays gas in USDC; testnet USDC from https://faucet.circle.com
export LEVY_TREASURY=0x...          # FeeRouter treasury
forge script script/Deploy.s.sol --rpc-url arc_testnet             # simulate
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast # deploy
```

Use `--rpc-url arc_mainnet` for mainnet, and add `--legacy` if fee estimation fails. `LEVY_USDC` and `LEVY_PERMIT2` override the Arc defaults. A deploy costs about 0.25 USDC of gas (simulated on testnet, 2026-09-25). Broadcast records land in `broadcast/`; commit the testnet and mainnet ones as the deployment record.

## Deployment notes (Arc mainnet)

- Chain ID 5042, RPC `https://rpc.mainnet.arc.io`. USDC is the gas token.
- **Verified 2026-09-25** (see `VERIFICATION.md`): single-block deterministic finality (~0.5s blocks, Malachite BFT, no reorgs) — the keeper's zero-confirmation design is correct. Transaction memos are **live on mainnet** (Memo contract `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`). Arc runs an Osaka-baseline EVM, so PUSH0 works; `evm_version = "paris"` in foundry.toml stays as a harmless conservative default.
- Permit2 on Arc mainnet is at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`, the same address as on Ethereum. The contract's `subscribeWithPermit2` uses it.
- Remaining pre-mainnet items: treasury multisig signers, production fee math sign-off, dunning copy review.

## Roadmap

- **M1:** contracts + tests (done)
- **M2:** keeper service, deduped indexer, dunning engine (done)
- **M3:** merchant dashboard, customer portal, signed webhooks, invoicing (done)
- **M4:** testnet soak, mainnet deploy
- **M5:** LEVY token — fee split to buyback-and-burn / staking, staking fee-tier discounts, premium feature gating

## License

MIT

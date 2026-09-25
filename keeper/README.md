# Levy Keeper

Off-chain service that executes pull-based USDC subscription charges on Arc. Watches the `SubscriptionManager` contract, calls permissionless `charge()` when subscriptions come due, and runs the dunning retry schedule on failures.

## What it does

Each cycle (default 30s):

1. **Sync** — pulls new `SubscriptionManager` and USDC `Transfer` events into SQLite, refreshes subscription state from chain.
2. **Charge due** — calls `charge(subId)` for TRIAL/ACTIVE subscriptions past `nextChargeAt`. Anyone can call `charge()`; the keeper is just the always-on anyone.
3. **Dunning retries** — re-calls `charge()` for failed subscriptions on the backoff schedule (default day 1, 3, 7). A success clears the schedule.
4. **Re-sync** — picks up this cycle's own receipts immediately.

Failed pulls never revert on-chain; the contract emits `ChargeFailed` and the keeper records it. At `maxFailed` failures the contract marks the subscription `PAST_DUE`; at `2x` it auto-pauses. The keeper never force-pauses for dunning.

## Setup

```bash
npm install
cp .env.example .env   # fill in addresses + keeper key
npm run build
npm start
```

Dev (ts-node style, no build):

```bash
npm run dev
```

## Tests

```bash
npm test              # unit + anvil integration (13 tests)
npm run test:integration
```

Integration tests spin up a local `anvil`, deploy `MockUSDC` + `FeeRouter` + `SubscriptionManager`, and run the keeper against them.

## Operational notes

- **Key safety.** `LEVY_KEEPER_KEY` is a hot EOA that pays gas (USDC on Arc). Fund it minimally, rotate if exposed, never commit it.
- **Idempotency.** `charge()` is safe to retry; the contract enforces `nextChargeAt` and state. The keeper dedupes within a cycle (a sub is charged once per cycle even if it appears in both the due sweep and the retry queue).
- **Chain time, not wall time.** All due/dunning math uses the chain-head timestamp, so the keeper behaves correctly across reorgs and test time-warps.
- **Single instance.** Run one keeper per deployment. Two keepers would race `charge()` calls (harmless on-chain — the second reverts or no-ops — but wasteful).
- **DB is the state.** `levy.db` holds sync cursors, dunning schedules, and charge history. Back it up; deleting it causes a full resync from `LEVY_LOOKBACK_BLOCKS`.
- **Transfer accounting.** `usdc_transfers` records raw ERC-20 `Transfer` logs for visibility. `dedupedTransfers()` collapses same-tx identical (from,to,amount) rows — see the doc comment in `src/db.ts` for the limitation. Charge truth comes from `Charged`/`ChargeFailed` events, not transfer sums.

## Layout

- `src/index.ts` — entrypoint, poll loop
- `src/keeper.ts` — cycle orchestration (sync → charge → retry → re-sync)
- `src/indexer.ts` — event sync, chain-state refresh
- `src/dunning.ts` — retry schedule math
- `src/db.ts` — SQLite schema and queries
- `src/chain.ts` — viem clients, ABI loading
- `src/config.ts` — env config

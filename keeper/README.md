# Levy Keeper

Off-chain service that executes pull-based USDC subscription charges on Arc. Watches the `SubscriptionManager` contract, calls permissionless `charge()` when subscriptions come due, and runs the dunning retry schedule on failures.

## What it does

Each cycle (default 30s):

1. **Sync** — pulls new `SubscriptionManager` and USDC `Transfer` events into SQLite, refreshes subscription state from chain.
2. **Charge due** — calls `charge(subId)` for TRIAL/ACTIVE/PAST_DUE subscriptions past `nextChargeAt`. Anyone can call `charge()`; the keeper is just the always-on anyone.
3. **Dunning retries** — re-calls `charge()` for failed subscriptions on the per-attempt backoff schedule (after failure 1: 1 day, failure 2: 3 days, failure 3+: 7 days; configurable). A success clears the schedule.
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

## Webhooks (M3)

The keeper doubles as a webhook dispatcher. Merchants register endpoints
(either via the API or directly in the `webhooks` table); contract events are
fanned out per merchant subscription:

- `subscription.created`, `subscription.updated` (plan change),
  `charge.succeeded`, `charge.failed`,
  `dunning.started` (first failure), `subscription.paused`,
  `subscription.resumed`, `subscription.cancelled`, `invoice.ready`
  (emitted alongside every `charge.succeeded`; the invoice is the charge record).

Deliveries are Ed25519-signed: `X-Levy-Signature` covers
`{X-Levy-Timestamp}.{X-Levy-Delivery}.{canonical JSON body}`, so receivers can
reject replays and dedupe on the delivery id (`verifyDelivery`). `X-Levy-Key-Id`
names the key; `X-Levy-Event` the event type. The signing key is
generated on first boot at `LEVY_WEBHOOK_KEY_PATH` (or inline via
`LEVY_WEBHOOK_KEY`); the public key is served at
`GET /api/webhooks/public-key`.

Deliveries only go to https URLs on public addresses. The address is checked
at connect time (so DNS rebinding after registration does not help), and
redirects are never followed. `LEVY_WEBHOOK_ALLOW_PRIVATE=1` lifts this for
local development only; see `src/webhook-url.ts`.

Delivery runs in its own loop (every `LEVY_WEBHOOK_POLL_MS`, default 5s),
separate from charge cycles, so a slow or hanging endpoint can delay webhooks
but never charges. Each pass sends up to 8 requests at once with a 5s timeout,
takes at most 200 deliveries (5 per webhook), serves every webhook's oldest
delivery before anyone's second, and keeps one request in flight per webhook so
its deliveries arrive in order. Failures retry with backoff (1m, 5m, 15m, 1h,
6h) and dead-letter after 24h. Delivery state lives in `webhook_deliveries`
(`pending` / `sent` / `failed` / `dead`).

## Tests

```bash
npm test              # unit + anvil integration (49 tests)
npm run test:integration
```

Integration tests spin up a local `anvil`, deploy `MockUSDC` + `FeeRouter` + `SubscriptionManager`, and run the keeper against them.

## Operational notes

- **Key safety.** `LEVY_KEEPER_KEY` is a hot EOA that pays gas (USDC on Arc). Fund it minimally, rotate if exposed, never commit it.
- **Idempotency.** `charge()` is safe to retry; the contract enforces `nextChargeAt` and state. The keeper dedupes within a cycle (a sub is charged once per cycle even if it appears in both the due sweep and the retry queue).
- **Chain time, not wall time.** All due/dunning math uses the chain-head timestamp, so the keeper behaves correctly across clock skew and test time-warps. (Arc has deterministic finality with no reorgs; this is belt-and-suspenders.)
- **Stuck charges back off.** A charge that fails for any reason other than payment (a revert, an RPC error) re-reads the subscription from chain and is retried after 1m, 5m, 15m, 1h, then every 6h, instead of every cycle. The backoff is in memory, so a restart tries each once more.
- **Log sync is chunked.** `eth_getLogs` goes out in `LEVY_LOG_CHUNK_BLOCKS` ranges (default 500; dRPC rejects 1,000) and the cursor advances after each, so a keeper that was down for a day catches up in ~350 requests.
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

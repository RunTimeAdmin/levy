# Levy Keeper

Off-chain service that runs Levy's pull-based USDC billing on Arc. It indexes the `SubscriptionManager` contract, calls the permissionless `charge()` when subscriptions come due, runs the dunning retry schedule, delivers signed webhooks to merchants, and warns when subscribers' allowances run low.

## What it does

Two independent loops run in one process (`src/index.ts`).

**Charge loop** (every `LEVY_POLL_MS`, default 30s):

1. **Sync:** fetches new logs (in chunks of `LEVY_LOG_CHUNK_BLOCKS`) and refreshes subscription and plan state from chain into SQLite.
2. **Charge due:** calls `charge(subId)` for TRIAL and ACTIVE subscriptions past `nextChargeAt` that have no open dunning entry. Anyone can call `charge()`; the keeper is just the always-on caller.
3. **Dunning retries:** re-calls `charge()` for failed subscriptions (including PAST_DUE ones) on the backoff schedule: 1 day after the first failure, 3 days after the second, then 7 days after each later one (`LEVY_DUNNING_DAYS`). A success clears the schedule. The contract enforces the same gaps (`retryGap`), so configured gaps can be longer but not shorter (a sooner retry reverts `RetryTooSoon` and falls into the revert backoff).
4. **Re-sync:** picks up this cycle's own receipts immediately.
5. **Allowance runway:** checks a bounded batch of subscribers' allowances (see Operational notes).

**Delivery loop** (every `LEVY_WEBHOOK_POLL_MS`, default 5s): sends due webhooks. It is separate so a slow merchant endpoint can never delay charging.

Failed pulls never revert on-chain; the contract emits `ChargeFailed` and the keeper records it. At `maxFailed` failures the contract marks the subscription PAST_DUE; at twice that it auto-pauses. The keeper never pauses anything itself.

## Setup

Requires Node 24 (Node 22.13 or later works: `node:sqlite` is built in).

```bash
npm install
cp .env.example .env   # fill in addresses + keeper key
npm start              # both loops; `npm run once` runs one charge cycle and one delivery pass
```

`npm start` and `npm run once` load `.env` if it exists. For production, build with `npx tsc` (output in `dist/`) and run `node dist/index.js` with the environment set by Docker (`ops/docker-compose.yml`) or systemd (`ops/keeper.service`).

## Webhooks

Merchants register endpoints through the API (`api/README.md`). Contract events are fanned out to the webhooks of the subscription's merchant. Every payload carries `subId`, `merchant` and `ref` (the merchant's reference from subscribe, or null), plus the fields of its event:

- `subscription.created`, `subscription.updated` (plan change),
  `charge.succeeded`, `charge.failed`,
  `dunning.started` (first failure), `subscription.paused` (`auto: true` for the contract's auto-pause),
  `subscription.resumed`, `subscription.cancelled`, `invoice.ready`
  (emitted alongside every `charge.succeeded`, with the same body; the invoice is the charge record),
  and `allowance.low` (from the allowance check, not a contract event; one per affected subscription).

Deliveries are Ed25519-signed: `X-Levy-Signature` covers
`{X-Levy-Timestamp}.{X-Levy-Delivery}.{X-Levy-Event}.{canonical JSON body}`, so
receivers can reject replays, dedupe on the delivery id and route on the event
type (`verifyDelivery` in `src/webhooks.ts`, which also rejects unknown event
types). `X-Levy-Key-Id` names the key. The signing key is loaded
from `LEVY_WEBHOOK_KEY_PATH`, or created there on first boot (or passed inline via
`LEVY_WEBHOOK_KEY`); the public key is served at `GET /api/webhooks/public-key`.

Deliveries only go to https URLs on port 443 at public addresses. The address is
checked at connect time (so DNS rebinding after registration does not help), and
redirects are never followed. `LEVY_WEBHOOK_ALLOW_PRIVATE=1` lifts this for local
development only; see `src/webhook-url.ts`.

Each delivery pass sends up to 8 requests at once with a 5s timeout, takes at
most 200 deliveries (5 per webhook), serves every webhook's oldest delivery
before anyone's second, and keeps one request in flight per webhook so a slow endpoint
is never hit twice at once. Order is not guaranteed: a failed delivery waits for
its backoff while later events can arrive first. Failures retry with backoff (1m,
5m, 15m, 1h, then every 6h), and a delivery whose next retry would pass 24h of age
is dead-lettered, so its last attempt is at about 19h21m. A deactivated or deleted webhook's pending deliveries are
dead-lettered, not held. Delivery state lives in `webhook_deliveries`
(`pending` / `sent` / `failed` / `dead`).

## Tests

```bash
npm test                 # unit tests + anvil integration test (59 tests)
npm run test:integration # the anvil test alone
```

The integration test needs `anvil` (Foundry) on PATH. It starts a local chain, deploys `MockUSDC`, `FeeRouter`, `MockPermit2` and `SubscriptionManager` from `abi/`, and runs the keeper against them (with 7-block log chunks, so every sync crosses chunk boundaries).

## Operational notes

- **Key safety.** `LEVY_KEEPER_KEY` is a hot EOA that pays gas (USDC on Arc). Fund it minimally, rotate if exposed, never commit it.
- **Single instance.** Run one keeper per deployment. A successful `charge()` is safe to race (the second call reverts `NotChargeable`), and so is a failing one: the contract records one failure per retry gap and the second call reverts `RetryTooSoon`. A second keeper cannot speed up dunning or double-charge; it only wastes gas and log queries. Within one keeper, a subscription is charged at most once per cycle.
- **Chain time, not wall time.** Due and dunning math uses the chain-head timestamp, so the keeper behaves correctly across clock skew and test time-warps. (Arc has deterministic finality with no reorgs; one block is final.) Webhook retry times use the wall clock.
- **Allowance runway.** After charging, each cycle reads the USDC allowance and balance of up to 50 subscribers whose last check is over 6h old (see `src/funds.ts`). A charge, or an `Approval` to the manager (a top-up), makes that subscriber due for a recheck on the next cycle. When the allowance covers fewer than 2 rounds of all their chargeable subscriptions, each affected subscription's merchant gets one `allowance.low` webhook; it repeats only after the allowance recovers. Only the direct ERC-20 allowance is read, so Permit2 subscribers are flagged low.
- **Stuck charges back off.** A charge that fails for any reason other than payment (a revert, an RPC error) re-reads the subscription from chain and is retried after 1m, 5m, 15m, 1h, then every 6h, instead of every cycle. The backoff is in memory, so a restart tries each once more.
- **Log sync is chunked and scoped.** Each `LEVY_LOG_CHUNK_BLOCKS` range (default 500; dRPC rejects 1,000) makes four `eth_getLogs` calls: the manager's events, USDC `Transfer`s into and out of the manager, and `Approval`s to it. The cursor advances after each chunk, so a keeper that was down for a day (~172,800 blocks) catches up in ~350 chunks (~1,400 requests). Never every USDC log: on Arc, USDC is the gas token (measured 25 Sep 2026: ~4,000 USDC logs per 500 blocks on testnet, ~1,200 on mainnet, i.e. ~1.4M and ~430k a day), which would swamp the DB and hit provider result caps.
- **Start-up.** Every start re-reads every plan and subscription from chain state (the backfill). With no sync cursor, the first sync also scans back `LEVY_LOOKBACK_BLOCKS` (default 5000, ~40 min) of logs. If the keeper starts long after the deploy, raise the lookback to reach the deploy block (printed by `script/Deploy.s.sol`) so charge history is indexed too.
- **DB is the state.** `levy.db` holds sync cursors, dunning schedules, charge history, webhook registrations and delivery logs, and API sessions. Back it up. Deleting it re-reads plans and subscriptions from chain but loses webhooks, history older than the lookback, and dunning schedules (PAST_DUE subscriptions without a schedule are not retried).
- **Transfer accounting.** `usdc_transfers` records the USDC `Transfer` logs into and out of the manager, for visibility. `dedupedTransfers()` collapses same-tx identical (from, to, amount) rows; see the doc comment in `src/db.ts` for the limitation. Charge truth comes from `Charged` / `ChargeFailed` events, not transfer sums.

## Layout

- `src/index.ts`: entrypoint, the two loops
- `src/keeper.ts`: charge cycle (sync, charge, retry, re-sync, allowance check), error backoff
- `src/indexer.ts`: chunked log sync, chain-state refresh
- `src/dunning.ts`: retry schedule math
- `src/funds.ts`: allowance runway rule
- `src/webhooks.ts`: event mapping, signing, delivery
- `src/webhook-url.ts`: webhook URL and address policy
- `src/db.ts`: SQLite schema and queries
- `src/chain.ts`: viem clients, ABI loading
- `src/config.ts`: env config

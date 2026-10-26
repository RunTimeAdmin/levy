# Monitoring and Maintenance

Levy ships a runbook of seven alerts written as shell and SQL checks (`ops/monitoring.md`) and a daily report script for the testnet soak. It does not ship a metrics exporter, dashboards, a backup job or certificate renewal config. This page covers what exists and marks every recommendation that has no repository tool behind it. Levy runs on Arc testnet only and is not audited, so none of this is tuned for mainnet traffic.

## What exists

| Tool | Gives you |
|---|---|
| `ops/monitoring.md` | The seven alerts below, with thresholds and SQL |
| `ops/soak-status.sh`, `ops/soak/status.mjs` | A daily soak-host report: containers, logs, health, certificate, chain against database, an alert list |
| `ops/soak/webhook-receiver.mjs` | An independent receiver that verifies every webhook signature (soak only) |
| `GET /api/health` | API liveness; Docker polls it every 30 s for `levy-api` |
| Keeper log lines | The only keeper signal. There is no keeper health endpoint or compose healthcheck. |

There is no Prometheus-style exporter: `GET /api/metrics` is merchant-scoped and needs a signed-in session, so a monitor cannot scrape it. Wire the checks below into whatever you already run, such as Uptime Kuma or cron with a notifier.

Amounts in the database are 6-decimal USDC units (1 USDC = 1,000,000). The keeper wallet's native gas balance has 18 decimals, which is why the commands below use `cast balance --ether`.

## Running the checks

The images do not include `sqlite3`, so run it on the host. The database is in WAL mode, so reading it while the keeper runs is safe.

```bash
# Docker (as root)
sqlite3 "$(docker volume inspect levy-data -f '{{ .Mountpoint }}')/levy.db" "<query>"
# systemd
sqlite3 /var/lib/levy/levy.db "<query>"
```

`subscriptions.status`: 0 trial, 1 active, 2 past_due, 3 paused, 4 cancelled, and with manager v2, 5 completed.

## The seven alerts

| # | Alert | Severity | Threshold |
|---|---|---|---|
| 1 | Keeper down or not charging | Page | Process not running for 2 minutes, or heartbeat above 0 for 15 minutes |
| 2 | Cycle errors | Page on burst | More than 5 `[cycle] error` lines in 15 minutes, or 3 in a row |
| 3 | Failed-charge spike | Investigate | More than 10 failures an hour, or 3 times the trailing 7-day hourly average |
| 4 | Dunning not retrying | Investigate | Stuck retries above 0 |
| 5 | Webhook dead letters | Investigate | Dead count grows, or the due backlog stays stuck |
| 6 | Keeper gas low | Page before zero | Below 1 USDC (the soak report's level) |
| 7 | API down | Page if the pages are customer-facing | 3 failures in a row at 1-minute checks |

**1. Keeper down or not charging.** Subscriptions then sit in TRIAL or ACTIVE with `nextChargeAt` in the past, and webhooks stop. Check `docker inspect -f '{{.State.Running}}' levy-keeper` (must be `true`) or `systemctl is-active levy-keeper`. The heartbeat also catches a running but stuck keeper:

```sql
SELECT COUNT(*) FROM subscriptions WHERE status IN (0,1)
  AND nextChargeAt < strftime('%s','now') - 900
  AND subId NOT IN (SELECT subId FROM dunning);
```

Docker restarts the keeper forever, so a long outage there means a crash loop. systemd stops after 5 failed starts in 5 minutes and shows `start-limit-hit`. Read `docker logs levy-keeper` or `journalctl -u levy-keeper` for the boot error. A non-zero heartbeat with a running process usually means charges are reverting: look for `! sub` lines. The keeper backs those off for up to 6 hours.

**2. Cycle errors.** The keeper is up but cycles throw (bad RPC, database lock). Count them with `docker logs --since 15m levy-keeper 2>&1 | grep -c "\[cycle\] error"`, or the `journalctl --since "15 min ago"` equivalent. One RPC hiccup is normal; a burst is not.

**3. Failed-charge spike.** Usually a USDC or allowance outage, or an RPC returning stale state.

```sql
SELECT COUNT(*) FROM charge_failures WHERE at > strftime('%s','now','-1 hour');
SELECT subId, failedAttempts, datetime(at,'unixepoch') FROM charge_failures
  WHERE at > strftime('%s','now','-1 hour') ORDER BY at DESC LIMIT 20;
```

Isolated failures are normal dunning. Many subscribers failing about 12 cycles after sign-up means their checkout allowance ran out, which `allowance.low` warns merchants about in advance.

**4. Dunning not retrying.** `SELECT COUNT(*), MAX(attempts) FROM dunning;` shows depth. Stuck retries:

```sql
SELECT COUNT(*) FROM dunning WHERE nextRetryAt < strftime('%s','now') - 3600;
```

Above zero means the retry loop is not running (alert 1) or the retry reverts and backs off for up to 6 hours. A large but moving queue is subscribers not topping up, a merchant matter.

**5. Webhook dead letters.** A merchant stopped receiving events, because their endpoint is down or Levy's signing or delivery is broken.

```sql
SELECT id, webhook_id, event_type, last_error FROM webhook_deliveries
  WHERE status='dead' ORDER BY id DESC LIMIT 20;
SELECT COUNT(*) FROM webhook_deliveries WHERE status IN ('pending','failed')
  AND next_retry_at < strftime('%s','now');
```

Compare the highest dead `id` with the last you saw. Do not filter by age: a delivery is dead-lettered when its next retry would pass 24 hours of age, so its last attempt is at about 19 h 21 min and a 24-hour window loses it within hours. `last_error` holds coarse reasons: `HTTP nnn`, `timeout after 5s`, `connection failed`, `refused: ...`, `invalid url`, `webhook deleted or deactivated`. If every merchant dead-letters at once, the fault is Levy's (signing key, egress). If one does, tell them; they can read their deliveries at `GET /api/deliveries`. A large stuck backlog means the delivery loop is not running, or hanging endpoints hold its 8 parallel slots (one merchant can hold at most 5). Charges are unaffected. See [Webhooks](Webhooks.md).

**6. Keeper gas.** On Arc, USDC is the gas token, so a dry keeper stops charging entirely. `cast balance <KEEPER_ADDRESS> --ether --rpc-url $LEVY_RPC_URL` prints whole USDC; the keeper address is printed at every boot. A charge costs about 0.003 USDC, and daily spend is today's balance against yesterday's. On mainnet pick a threshold that covers several days. Refill from the treasury (on testnet, the Circle faucet).

**7. API down.** `curl -sf http://127.0.0.1:3001/api/health` from the host. The keeper keeps charging without the API, so this ranks below alerts 1 and 2, but the dashboard, portal, checkout and the webhook public-key endpoint go dark.

**Triage order:** (1) is the keeper up and charging, (2) are cycles erroring, (3) is it funded, (4) is it a subscriber-side wave or a Levy-side break (alerts 3 to 5).

**Do not alert on** individual `ChargeFailed` events, single dunning rows or `allowance.low` warnings, which are the product working as designed. A quiet log is fine too: the keeper logs only cycles that charged, retried or failed something. `usdc_transfers` row counts are informational, never charge truth.

## Logs

Keeper output is plain text on stdout and stderr; there is no structured logging.

| Line | Meaning |
|---|---|
| `levy keeper: chain=... manager=... keeper=0x...` | Boot. Shows the keeper address to fund. |
| `backfilled N subscriptions` | Boot hydration from the chain |
| `[cycle] charged=a retried=b failed=c logs=n` | A cycle that did something. Failures follow as `  ! sub <id>: <reason>`. |
| `[cycle] error: ...` | The cycle threw; the loop carries on |
| `[webhooks] sent=a failed=b dead=c` | A delivery pass with activity |
| `[webhooks] error: ...` | A delivery pass threw |

Read them with `docker logs -f levy-keeper` (add `--since 15m` to window) or `journalctl -u levy-keeper -f`. Compose keeps 5 files of 50 MB per container; under systemd, journald's limits apply. The API prints one startup line (and the error, if it fails to boot) and nothing per request, because its logger is off.

## Daily soak report

On the soak host, `bash ops/soak-status.sh` (from the repo copy) prints the three Levy containers with restart counts; the keeper log over 24 hours (cycles with errors, rate limits, charges, retries, webhook passes); API health, the certificate's expiry date, disk and volume size; a summary of the receiver's log; and then `ops/soak/status.mjs`, run inside the keeper container against its database (read-only) and the chain. That last part lists sync lag, the keeper wallet, every subscription as the chain sees it, money, dunning, low allowances and webhook counts, and ends with these alerts:

| Alert | Condition |
|---|---|
| Keeper behind | More than 1200 blocks (10 minutes) behind the chain head |
| Keeper wallet low | Under 1 USDC |
| Database and chain disagree | Charge count, status or `nextChargeAt` differs for a subscription |
| Late charge | Last charge more than 300 s after its billing date |
| Overdue | A chargeable subscription's next charge or retry is over 300 s past |
| Fee rule broken | Any charge where `fee` is not `floor(amount / 100)` |
| Dead delivery | Any webhook delivery in `dead` |

The "charge transactions that errored" count includes recorded payment failures, so the soak's planned failing subscription raises it. Two checks stay manual: that the merchant received 99% of each charge, and that USDC moved only to the merchant and the fee router.

The receiver runs as `levy-soak-hooks` from `ops/soak/docker-compose.yml` on loopback port 3002, behind an nginx `location ^~ /soak-hooks` block. It fetches the signing public key and checks each delivery as the merchant guide describes: signature, a 5-minute timestamp window (a fixed constant), a known event type, and duplicate delivery ids. It appends one JSON line per delivery to `ops/soak/data/hooks.jsonl` and always answers 200, so delivery counts and signature results can be read separately. It is soak-only. See [Testing](Testing.md#live-test-the-testnet-soak).

## Backups and database loss

`levy.db` holds the sync cursor, charge history, dunning schedules, webhook registrations and delivery log, API sessions and allowance runway. Plans and subscriptions also live on-chain. The webhook signing key sits beside it as `webhook-signing-key.pem`.

**Backup (a recommendation; there is no repository tool).** Take a consistent copy on the host with `sqlite3 levy.db ".backup /safe/place/levy.db"`, copy the signing key with it, keep copies off the host, and test a restore. Back up before every upgrade: the schema is created at startup with `CREATE TABLE IF NOT EXISTS` plus an `ALTER TABLE ... ADD COLUMN` for each column added later (`ref`, `pausedByMerchant` and the manager v2 columns on `subscriptions` and `plans`), and there is no migration tool. Keep the key because, if the file is missing, the keeper generates a new one at start (and the API does on its next public-key request), and merchants who cached the old public key then fail verification.

**Loss.** With no database, the keeper rebuilds plans, their merchant accounts and subscriptions from the chain at start (`backfillAll`). It loses webhook registrations (merchants register again), the delivery log, sessions (users sign in again), charge history older than `LEVY_LOOKBACK_BLOCKS` (raise it to reach the deploy block to re-index charges), and dunning schedules.

The dunning loss is a known open item (`SECURITY_REVIEW.md` section 9; finding 10 of `docs/REVIEW_2026-10-02.md`). The ordinary due query selects only TRIAL and ACTIVE subscriptions, and retries come only from `dunning` rows, so a PAST_DUE subscription with no row is never retried although the contract would still charge it. The review's proposed fix, rebuilding the schedule from on-chain failure counts after a rescan from the deploy block, is not built. A suggested check (not in `monitoring.md`) lists the orphans after any restore:

```sql
SELECT subId FROM subscriptions WHERE status = 2 AND subId NOT IN (SELECT subId FROM dunning);
```

## Upgrading the keeper and API

Run one keeper per deployment. A second cannot double-charge or speed up dunning (its duplicate call reverts) but wastes gas and log queries. Compose fixes the container name `levy-keeper`, so it will not start a second copy; do not also run the systemd unit.

1. Back up the database and key.
2. Put the new revision on the host. The soak report prints the revision from a `REVISION` file in the repo copy, if there is one.
3. `docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build` rebuilds and recreates changed containers and leaves the `levy-data` volume alone. Rebuild both images when `keeper/src` changed, since the API compiles it too. Under systemd: `npm ci`, `npx tsc`, `npm prune --omit=dev` in `keeper/`, then `systemctl restart levy-keeper`.
4. Confirm the boot lines, `/api/health` and the next `[cycle]` line.

On SIGINT or SIGTERM the keeper sets a flag that each loop checks after its sleep, so with the default 30 s poll interval Docker's 10 s grace period usually ends in SIGKILL. That is safe. State lives in SQLite and on-chain, and the only in-memory state is the revert backoff, so each stuck subscription is tried once more after a restart. A charge transaction cut off mid-flight is either mined, and the next sync records it, or not; a repeat `charge()` on a paid cycle reverts, so nothing is charged twice. The soak plan includes a drill that restarts the keeper right before a due charge (`ops/testnet-soak.md`, day 4).

Rollback is a rebuild. Compose tags images `levy-keeper:latest` and `levy-api:latest` and the repository pushes them to no registry, so check out the previous revision and run the same command. A contract change is a new deployment, not an upgrade (see [Deployment](Deployment.md)).

## Key rotation

| Key | How |
|---|---|
| Keeper key | Create a new wallet, fund it, run `ops/set-keeper-key.sh`, recreate the keeper container. No on-chain step is needed: `charge()` is permissionless and the contracts never register the keeper. Move the old wallet's remaining USDC out. Rotate at once if the key may be exposed. |
| Webhook signing key | No tool exists; this is derived from the code and not rehearsed. The keeper reads the key once at start, while the API re-reads the file on every public-key request. Stop the keeper, replace the PEM (or delete it so a new one is generated), start the keeper. The API picks up the file at once, so a keeper left running would sign with the old key while the API published the new one. |
| Treasury | Two steps: the current treasury calls `FeeRouter.proposeTreasury(<new>)`, then the new address calls `acceptTreasury()`. On mainnet the current treasury is the Safe; see `ops/treasury-multisig.md`. |

After a signing-key change, `X-Levy-Key-Id` and the public-key endpoint carry a new `keyId`. Levy signs with one key per deployment, so there is no overlap period and merchants must refetch the public key. Queued deliveries are signed when sent, so they use the new key. Never paste a private key into chat or a ticket; `set-keeper-key.sh` exists to avoid that.

## Certificate renewal

Renewal is certbot's job on the host; the repository ships no renewal config. Recommended: run `certbot renew --dry-run` once after setup, keep port 80 reachable for HTTP-01 renewals, and alert when the certificate has under 14 days left. The soak report already prints the expiry date (from `openssl s_client` against the public origin), so a failed renewal shows within a day on the soak host. The 14-day alert is a suggestion, not part of `ops/monitoring.md`.

## Source files

- [ops/monitoring.md](https://github.com/RunTimeAdmin/levy/blob/main/ops/monitoring.md)
- [ops/soak-status.sh](https://github.com/RunTimeAdmin/levy/blob/main/ops/soak-status.sh)
- [ops/soak/status.mjs](https://github.com/RunTimeAdmin/levy/blob/main/ops/soak/status.mjs)
- [ops/soak/webhook-receiver.mjs](https://github.com/RunTimeAdmin/levy/blob/main/ops/soak/webhook-receiver.mjs)
- [ops/soak/docker-compose.yml](https://github.com/RunTimeAdmin/levy/blob/main/ops/soak/docker-compose.yml)
- [ops/testnet-soak.md](https://github.com/RunTimeAdmin/levy/blob/main/ops/testnet-soak.md)
- [ops/docker-compose.yml](https://github.com/RunTimeAdmin/levy/blob/main/ops/docker-compose.yml)
- [ops/keeper.service](https://github.com/RunTimeAdmin/levy/blob/main/ops/keeper.service)
- [ops/set-keeper-key.sh](https://github.com/RunTimeAdmin/levy/blob/main/ops/set-keeper-key.sh)
- [keeper/src/index.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/index.ts)
- [keeper/src/keeper.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/keeper.ts)
- [keeper/src/webhooks.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhooks.ts)
- [keeper/src/db.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/db.ts)
- [api/src/server.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/server.ts)
- [SECURITY_REVIEW.md](https://github.com/RunTimeAdmin/levy/blob/main/SECURITY_REVIEW.md)

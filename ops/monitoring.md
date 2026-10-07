# Levy monitoring

What to alert on, where to check it, and suggested thresholds. Wire these into
whatever DC already uses (Uptime Kuma, cron + ntfy, etc.).

**Running the SQL.** The images do not include `sqlite3`; run it on the host.
The DB is in WAL mode, so reading it while the keeper runs is safe.
- Docker: `sqlite3 "$(docker volume inspect levy-data -f '{{ .Mountpoint }}')/levy.db" "<query>"` (as root).
- systemd: `sqlite3 /var/lib/levy/levy.db "<query>"`.

Status codes in `subscriptions.status`: 0 trial, 1 active, 2 past_due, 3 paused, 4 cancelled.

## 1. Keeper down or not charging: PAGE

Symptom: nothing is charged. Subscriptions do not change state on-chain; they
sit TRIAL or ACTIVE with `nextChargeAt` in the past, and webhooks stop.
- Docker: `docker inspect -f '{{.State.Running}}' levy-keeper` must be `true`.
- systemd: `systemctl is-active levy-keeper` must be `active`.
- Heartbeat (catches a running but stuck keeper too): due subscriptions left
  uncharged for 15 minutes.
  `SELECT COUNT(*) FROM subscriptions WHERE status IN (0,1)
   AND nextChargeAt < strftime('%s','now') - 900
   AND subId NOT IN (SELECT subId FROM dunning);`
- Threshold: process not running for more than 2 minutes, or the heartbeat
  above 0 for 15 minutes. Docker restarts the keeper indefinitely, so a sustained
  down state there means crash-looping. systemd gives up after 5 failed starts
  in 5 minutes (`StartLimitBurst`), after which `levy-keeper` shows `failed` and
  `systemctl status` says `start-limit-hit`. Check `journalctl -u levy-keeper` or
  `docker logs levy-keeper` for the boot error. A non-zero heartbeat with a
  running process usually means charges are reverting (look for `! sub` lines
  in the log; the keeper backs those off for up to 6h).

## 2. Cycle errors: PAGE on burst

Symptom: the keeper is up but cycles throw (bad RPC, DB lock).
- `journalctl -u levy-keeper --since "15 min ago" | grep -c "\[cycle\] error"`
  (Docker: `docker logs --since 15m levy-keeper 2>&1 | grep -c "\[cycle\] error"`)
- Threshold: more than 5 errors in 15 minutes, or any 3 in a row. Single
  transient RPC hiccups are normal; bursts are not.

## 3. Failed-charge spike: INVESTIGATE (business hours ok)

Symptom: many subscribers failing at once, usually a USDC or allowance
outage, or an RPC returning stale state.
- `SELECT COUNT(*) FROM charge_failures WHERE at > strftime('%s','now','-1 hour');`
- Threshold: more than 10 failures an hour, or 3x the trailing 7-day hourly
  average. Drill down with:
  `SELECT subId, failedAttempts, datetime(at,'unixepoch') FROM charge_failures
   WHERE at > strftime('%s','now','-1 hour') ORDER BY at DESC LIMIT 20;`
- Isolated failures are the normal dunning flow, not an incident. Many
  subscribers failing around 12 cycles after they signed up means their
  checkout allowance ran out: that is what `allowance.low` warns merchants
  about in advance.

## 4. Dunning not retrying: INVESTIGATE

Symptom: failed subscriptions are never retried.
- `SELECT COUNT(*), MAX(attempts) FROM dunning;` shows depth.
- Stuck retries: `SELECT COUNT(*) FROM dunning WHERE nextRetryAt < strftime('%s','now') - 3600;`
- Threshold: stuck retries above 0 means the retry loop is not running (see
  alert 1) or the retry is reverting and backing off for up to 6h (look for `! sub`
  lines in the log). A large but moving dunning count is subscribers not topping up, a
  merchant matter.

## 5. Webhook dead-letters: INVESTIGATE

Symptom: a merchant stopped receiving events (their endpoint down, or Levy's
signing or delivery broken).
- `SELECT id, webhook_id, event_type, last_error FROM webhook_deliveries
   WHERE status='dead' ORDER BY id DESC LIMIT 20;`
- Threshold: the dead count grows, or the highest dead `id` passes the last one
  you saw. Do not filter on age: a delivery is dead-lettered when its next retry
  would pass 24 hours of age, so its last attempt is at about 19 h 21 min and a
  24-hour window loses it within hours. Look at `last_error` (coarse reasons:
  `HTTP nnn`, `timeout after 5s`, `connection failed`, `refused: ...`,
  `invalid url`, `webhook deleted or deactivated`). If every merchant
  dead-letters at once, the bug is on Levy's side (signing key, egress). If one
  merchant, tell them; they can see deliveries via `GET /api/deliveries`.
- Also watch the due backlog:
  `SELECT COUNT(*) FROM webhook_deliveries WHERE status IN ('pending','failed')
   AND next_retry_at < strftime('%s','now');`
  A large stuck backlog means the delivery loop isn't running, or hanging
  endpoints are holding the 8 parallel slots (one merchant can hold at most 5:
  5 webhooks, one request each). Charges are unaffected; delivery has its own
  loop. `[webhooks]` lines in the keeper log show each pass.

## 6. Keeper gas (USDC) balance low: PAGE before it hits zero

On Arc, USDC is the gas token: a dry keeper stops charging entirely.
- `cast balance <KEEPER_ADDRESS> --ether --rpc-url $LEVY_RPC_URL`
  prints the balance in whole USDC (the native balance has 18 decimals; plain
  `cast balance` prints 18-decimal base units).
- Threshold: below 1 USDC pages (`ops/soak/status.mjs` alerts at that level); on
  mainnet pick a level that covers several days of charges at about 0.003 USDC
  each. For the daily spend, compare the balance with yesterday's. Refill from
  treasury; the keeper address is
  printed on every boot (`levy keeper: ... keeper=0x...`).

## 7. API down: PAGE if the pages are customer-facing

- `curl -sf http://127.0.0.1:3001/api/health` (from the host; the port is bound
  to loopback).
- Threshold: 3 consecutive failures at 1-minute checks. The keeper keeps
  charging without the API, so this is lower priority than 1 and 2, but the
  dashboard, portal, checkout and webhook public-key endpoint go dark with it.

## Quick triage order

1. Is the keeper process up, and is it charging? (alert 1)
2. Are cycles erroring? (alert 2)
3. Is the keeper funded? (alert 6)
4. Is it a subscriber-side wave or a Levy-side break? (alerts 3 to 5)

## What NOT to alert on

- Individual `ChargeFailed` events, single dunning rows or `allowance.low`
  warnings: that is the product working as designed.
- Quiet cycles (no `[cycle]` log lines): the keeper only logs cycles that
  charged, retried, or failed something. Silence with a running process and a
  zero heartbeat is fine.
- `usdc_transfers` row counts: informational, never charge truth.

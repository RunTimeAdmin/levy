# Levy monitoring

What to alert on, where to check it, and suggested thresholds. Wire these into
whatever DC already uses (Uptime Kuma, cron + ntfy, etc.). DB path depends on
deploy mode: `/data/levy.db` (Docker volume) or `/var/lib/levy/levy.db`
(systemd). All SQL below is run with `sqlite3 <db-path> "<query>"`.

## 1. Keeper process down — PAGE

Symptom: no charges are being attempted; subscriptions go PAST_DUE silently.
- Docker: `docker inspect -f '{{.State.Running}}' levy-keeper` → must be `true`.
- systemd: `systemctl is-active levy-keeper` → must be `active`.
- Threshold: not running for > 2 minutes. Both deploy modes restart on failure
  automatically, so a sustained down state means crash-looping — check
  `journalctl -u levy-keeper` / `docker logs levy-keeper` for the boot error.

## 2. Cycle errors — PAGE on burst

Symptom: keeper is up but every cycle throws (bad RPC, reverted calls, DB lock).
- `journalctl -u levy-keeper --since "15 min ago" | grep -c "\[cycle\] error"`
  (Docker: `docker logs --since 15m levy-keeper 2>&1 | grep -c "\[cycle\] error"`)
- Threshold: more than 5 errors in 15 minutes, or any 3 in a row. Single
  transient RPC hiccups are normal; bursts are not.

## 3. Failed-charge spike — INVESTIGATE (business hours ok)

Symptom: many subscribers failing at once — usually a USDC/allowance outage,
a bad plan push, or an RPC returning stale balances.
- `SELECT COUNT(*) FROM charge_failures WHERE at > strftime('%s','now','-1 hour');`
- Threshold: more than 10 failures/hour, or 3x the trailing 7-day hourly
  average. Drill down with:
  `SELECT subId, failedAttempts, datetime(at,'unixepoch') FROM charge_failures
   WHERE at > strftime('%s','now','-1 hour') ORDER BY at DESC LIMIT 20;`
- Note: isolated failures are the normal dunning flow, not an incident.

## 4. Dunning depth growth — INVESTIGATE

Symptom: retries never succeeding — subscribers not topping up, or the keeper
failing to collect on retry.
- `SELECT COUNT(*), MAX(attempts) FROM dunning;`
- Threshold: count growing monotonically over 24h, or more than 50 open rows.
  Cross-check with alert 3: if failures are flat but dunning grows, retries
  themselves are broken.

## 5. Webhook dead-letters — INVESTIGATE

Symptom: a merchant stopped receiving events (their endpoint down, or Levy
signing/delivery broken).
- `SELECT webhook_id, event_type, last_error FROM webhook_deliveries
   WHERE status='dead' AND created_at > strftime('%s','now','-24 hours');`
- Threshold: any row → look at `last_error`. If every merchant dead-letters at
  once, the bug is on Levy's side (signing key, egress). If one merchant,
  notify them; deliveries stay queryable via `GET /api/deliveries`.
- Also watch the pending backlog:
  `SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending'
   AND next_retry_at < strftime('%s','now');`
  A large stuck backlog means the delivery loop isn't running, or one
  merchant's endpoints are hanging and eating the 8 parallel slots (charges
  are unaffected; delivery has its own loop). `[webhooks]` lines in the keeper
  log show each pass.

## 6. Keeper gas (USDC) balance low — PAGE before it hits zero

On Arc, USDC is the gas token: a dry keeper stops charging entirely.
- `cast balance <KEEPER_ADDRESS> --rpc-url $LEVY_RPC_URL`
  (returns USDC base units, 6 decimals — divide by 1e6)
- Threshold: below ~$20 USDC. Refill from treasury; the keeper address is
  printed on every boot (`levy keeper: ... keeper=0x...`).

## 7. API down — PAGE if the dashboard is customer-facing

- `curl -sf http://127.0.0.1:3001/api/health`
- Threshold: 3 consecutive failures at 1-minute checks. The keeper keeps
  charging without the API, so this is lower priority than 1–2, but the
  merchant dashboard and webhook public-key endpoint go dark with it.

## Quick triage order

1. Is the keeper process up? (alert 1)
2. Are cycles erroring? (alert 2)
3. Is the keeper funded? (alert 6)
4. Is it a subscriber-side wave or a Levy-side break? (alerts 3–5)

## What NOT to alert on

- Individual `ChargeFailed` events or single dunning rows — that is the product
  working as designed.
- Quiet cycles (no `[cycle]` log lines): the keeper only logs cycles that
  charged, retried, or failed something. Silence with a running process is fine.
- `usdc_transfers` row counts — informational accounting, never charge truth.

#!/usr/bin/env bash
# Daily report for the testnet soak (ops/testnet-soak.md). On the soak host:
#
#   bash /docker/levy/ops/soak-status.sh
#
# Host checks first (containers, keeper log, API, certificate, disk, the soak
# webhook receiver's log), then ops/soak/status.mjs inside the keeper container
# for the chain and the keeper's database. Ends with a list of alerts.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."   # the repo copy, e.g. /docker/levy
ORIGIN=$(grep '^LEVY_PUBLIC_ORIGIN=' ops/.env | cut -d= -f2-)
HOST=${ORIGIN#https://}

echo "== Levy soak status, $(date -u '+%Y-%m-%d %H:%M') UTC, revision $(cat REVISION 2>/dev/null || echo unknown)"

echo
echo "== Containers"
for c in levy-keeper levy-api levy-soak-hooks; do
  if docker inspect "$c" >/dev/null 2>&1; then
    printf '%-16s %s, restarts %s\n' "$c" "$(docker ps -a --filter "name=^$c$" --format '{{.Status}}')" "$(docker inspect -f '{{.RestartCount}}' "$c")"
  else
    printf '%-16s not present\n' "$c"
  fi
done

echo
echo "== Keeper log, last 24 h"
LOG=$(docker logs --since 24h levy-keeper 2>&1)
echo "cycles with an error: $(grep -c '^\[cycle\] error' <<<"$LOG"), of them rate limits: $(grep -A6 '^\[cycle\] error' <<<"$LOG" | grep -c 'rate limit')"
awk -F'[= ]' '/^\[cycle\] charged=/ {c += $3; r += $5; f += $7} END {printf "charged %d, dunning retries %d, charge transactions that errored %d\n", c, r, f}' <<<"$LOG"
echo "webhook passes with sends: $(grep -c '^\[webhooks\] sent' <<<"$LOG"), webhook errors: $(grep -c '^\[webhooks\] error' <<<"$LOG")"

echo
echo "== API and host"
echo "health: $(curl -s -m 10 "$ORIGIN/api/health" || echo unreachable)"
echo "certificate expires: $(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
echo "disk: $(df -h / | awk 'NR==2 {print $3 " used of " $2 " (" $5 ")"}'), levy-data volume: $(du -sh "$(docker volume inspect -f '{{.Mountpoint}}' levy-data)" 2>/dev/null | cut -f1)"

echo
echo "== Webhook receiver (soak)"
python3 - ops/soak/data/hooks.jsonl <<'PY'
import json, sys, os
path = sys.argv[1]
events = ["subscription.created", "subscription.updated", "charge.succeeded", "invoice.ready", "charge.failed",
          "dunning.started", "subscription.paused", "subscription.resumed", "subscription.cancelled", "allowance.low"]
if not os.path.exists(path):
    print("no deliveries received yet")
    sys.exit(0)
rows = [json.loads(l) for l in open(path) if l.strip()]
bad = [r for r in rows if not r.get("sigValid")]
stale = [r for r in rows if not r.get("fresh")]
dups = [r for r in rows if r.get("duplicate")]
seen = {}
for r in rows:
    seen[r.get("event")] = seen.get(r.get("event"), 0) + 1
print(f"received {len(rows)}: signature invalid {len(bad)}, outside the 5-minute window {len(stale)}, redelivered {len(dups)}")
print("by event: " + ", ".join(f"{e} {n}" for e, n in sorted(seen.items(), key=lambda x: str(x[0]))))
missing = [e for e in events if e not in seen]
print("not seen yet: " + (", ".join(missing) if missing else "none, all ten received"))
for r in bad:
    print(f"! INVALID SIGNATURE: delivery {r.get('delivery')} ({r.get('event')}) at {r.get('receivedAt')}")
PY

echo
docker exec -i levy-keeper node --input-type=module < ops/soak/status.mjs

#!/usr/bin/env bash
# Stores the keeper's private key in ops/.env (next to this script) without
# echoing it, then prints the address it belongs to and that address's USDC
# balance on the configured chain, so you can check it is the wallet you funded.
#
#   bash /docker/levy/ops/set-keeper-key.sh
#
# Paste the value from the "Private key: 0x..." line of `cast wallet new` for
# the KEEPER wallet (not the deployer). Needs the levy-keeper image to be built.
set -euo pipefail

ENV_FILE="${LEVY_ENV_FILE:-$(dirname "$(readlink -f "$0")")/.env}"
[ -f "$ENV_FILE" ] || { echo "STOPPED: no $ENV_FILE"; exit 1; }

read -rsp "Paste the KEEPER wallet's private key, then press Enter (nothing shows): " K
echo
K=$(printf '%s' "$K" | tr -d '[:space:]')
[[ $K == 0x* ]] || K="0x$K"
if [[ $K =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "STOPPED: that was an ADDRESS (40 hex characters). The private key is 64 hex characters. Nothing was saved."
  exit 1
fi
if [[ ! $K =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "STOPPED: that is not a private key (expected 0x and 64 hex characters). Nothing was saved."
  exit 1
fi

# Derive the address with viem from the keeper image; the key goes in on stdin.
ADDR=$(printf '%s' "$K" | docker run --rm -i --entrypoint node levy-keeper:latest --input-type=module -e \
  "import { privateKeyToAccount } from 'viem/accounts'; let k = ''; for await (const c of process.stdin) k += c; console.log(privateKeyToAccount(k.trim()).address);")

# The key reaches awk through its environment, never its arguments: a command
# line is visible to every user on the host (ps, /proc/*/cmdline), a process's
# environment only to its owner. Adds the line when the file has none.
chmod 600 "$ENV_FILE"
TMP=$(mktemp "$ENV_FILE.XXXXXX")
trap 'rm -f "$TMP"' EXIT
LEVY_NEW_KEEPER_KEY="$K" awk '
  BEGIN { k = ENVIRON["LEVY_NEW_KEEPER_KEY"] }
  /^LEVY_KEEPER_KEY=/ { if (!done) print "LEVY_KEEPER_KEY=" k; done = 1; next }
  { print }
  END { if (!done) print "LEVY_KEEPER_KEY=" k }
' "$ENV_FILE" > "$TMP"
# Rewrite in place so the file keeps its owner and mode.
cat "$TMP" > "$ENV_FILE"
unset K

echo "Saved to $ENV_FILE."
echo "Keeper address: $ADDR"

# The RPC rejects Python's default user agent, so send a named one.
RPC=$(grep '^LEVY_RPC_URL=' "$ENV_FILE" | cut -d= -f2-)
BAL=$(python3 - "$RPC" "$ADDR" 2>/dev/null <<'PY' || echo "unknown (RPC lookup failed)"
import json, sys, urllib.request
rpc, addr = sys.argv[1], sys.argv[2]
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance", "params": [addr, "latest"]}).encode()
req = urllib.request.Request(rpc, body, {"content-type": "application/json", "user-agent": "levy-keeper-setup"})
print(int(json.load(urllib.request.urlopen(req, timeout=15))["result"], 16) / 1e18)
PY
)
echo "Balance:        $BAL USDC"

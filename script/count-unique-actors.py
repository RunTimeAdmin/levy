#!/usr/bin/env python3
"""Count distinct addresses that have interacted with Levy contracts on Arc.

Used to estimate the Arc Builder Allocations claim (distinct addresses hitting
your contracts). Queries eth_getLogs for ERC-20 Transfer and Permit2 events
across the given contract addresses on any EVM chain (Arc testnet/mainnet).

Usage:
    python script/count-unique-actors.py \
        --rpc https://rpc.testnet.arc.network \
        --contracts 0xYourManager 0xYourVault 0xYourFeeTreasury \
        [--from-block 0] [--to-block latest]

Prints the unique address count and writes addresses to unique-actors.txt.
"""

import argparse
import json
import sys
import urllib.request


TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
PERMIT2_SPEND_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"  # Permit2 Transfer (spender, from, to)


def rpc_call(url, method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    if "error" in data:
        raise RuntimeError(f"RPC error: {data['error']}")
    return data["result"]


def get_logs(url, address, topics, from_block, to_block):
    """Paginate eth_getLogs in 2k-block chunks to avoid node limits."""
    logs = []
    start = from_block
    while start <= to_block:
        end = min(start + 1999, to_block)
        chunk = rpc_call(
            url,
            "eth_getLogs",
            [{
                "address": address,
                "topics": topics,
                "fromBlock": hex(start),
                "toBlock": hex(end),
            }],
        )
        logs.extend(chunk)
        start = end + 1
        if end % 20000 == 0:
            print(f"  scanned through block {end:,}...", file=sys.stderr)
    return logs


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rpc", required=True, help="Arc RPC endpoint")
    p.add_argument("--contracts", required=True, nargs="+", help="Levy contract addresses")
    p.add_argument("--from-block", type=int, default=0)
    p.add_argument("--to-block", default="latest")
    args = p.parse_args()

    to_block = args.to_block
    if to_block == "latest":
        to_block = int(rpc_call(args.rpc, "eth_blockNumber", []), 16)

    actors = set()
    for addr in args.contracts:
        addr = addr.lower()
        print(f"Scanning {addr} from block {args.from_block:,} to {to_block:,}", file=sys.stderr)

        # ERC-20 Transfer: from = topic1
        for log in get_logs(args.rpc, addr, [TRANSFER_TOPIC], args.from_block, to_block):
            if len(log["topics"]) >= 2:
                actors.add("0x" + log["topics"][1][-40:])
            actors.add(log["address"].lower())  # the contract itself

        # Permit2 spend events: from = topic2
        for log in get_logs(args.rpc, addr, [PERMIT2_SPEND_TOPIC], args.from_block, to_block):
            if len(log["topics"]) >= 3:
                actors.add("0x" + log["topics"][2][-40:])

    # Drop the zero address (mint/burn noise)
    actors.discard("0x" + "0" * 40)

    print(f"\nUnique interacting addresses: {len(actors):,}")
    with open("unique-actors.txt", "w") as f:
        for a in sorted(actors):
            f.write(a + "\n")
    print("Wrote unique-actors.txt")


if __name__ == "__main__":
    main()

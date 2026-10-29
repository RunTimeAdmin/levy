#!/usr/bin/env python3
"""Count the distinct addresses that sent transactions to Levy's contracts.

Used to estimate the Arc Builder Allocations claim (distinct addresses hitting
your contracts). An address counts once it has sent a successful transaction
in which one of the given contracts emitted a log: a merchant's createPlan, a
subscriber's subscribe, the keeper's charge, a sweep. A deploy counts its
deployer. Calls that revert emit nothing and do not count, and neither does
an approval on its own, since that is a call to USDC, not to Levy.

It counts transaction senders (tx.from), not customers. A transaction sent
through a Safe, a relayer or a smart account counts whoever sent it, not the
account that called Levy. Pass service addresses such as the keeper with
--exclude: they are listed apart and left out of the count.

Only logs emitted by the given contracts are read. USDC's Transfer logs are
emitted by USDC itself, so they never match a Levy address, and Permit2 emits
no event for a transfer.

Usage:
    python script/count-unique-actors.py \\
        --rpc https://rpc.testnet.arc.io --chain-id 5042002 \\
        --contracts 0xSubscriptionManager 0xFeeRouter \\
        --from-block <deploy block> [--to-block <block>] [--exclude 0xKeeper]

For an endpoint with a key in its URL, set LEVY_RPC_URL instead of passing
--rpc, so the key stays out of shell history and the process list. The script
never prints the endpoint.

Writes unique-actors.json with the chain id, contracts, block range, method and
every address with its transaction count. The file appears only once the whole
range has been scanned, and only if the endpoint is on --chain-id.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

METHOD = (
    "distinct senders (tx.from) of transactions in which a given contract emitted a log; "
    "a Safe, relayer or smart-account transaction counts its sender, not the account that called Levy"
)


def make_rpc(url, timeout=60, retries=6, sleep=time.sleep):
    def call(method, params):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        # Arc's public RPC answers 403 to urllib's default User-Agent.
        req = urllib.request.Request(
            url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "levy-count-unique-actors"}
        )
        # Public RPCs rate limit (429): back off 1, 2, 4... seconds and try again.
        for attempt in range(retries + 1):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.load(resp)
                break
            except urllib.error.HTTPError as e:
                if (e.code != 429 and e.code < 500) or attempt == retries:
                    raise
            except (urllib.error.URLError, TimeoutError):
                if attempt == retries:
                    raise
            sleep(2**attempt)
        if "error" in data:
            raise RuntimeError(f"RPC error in {method}: {data['error']}")
        return data["result"]

    return call


def block_ranges(start, end, size):
    """Inclusive [from, to] ranges of at most `size` blocks covering start..end."""
    while start <= end:
        stop = min(start + size - 1, end)
        yield start, stop
        start = stop + 1


def count_senders(rpc, contracts, from_block, to_block, chunk, progress=None):
    """Map each sender to the number of its transactions that touched the contracts.

    A transaction sits in one block, so its logs all arrive in one range: the
    transaction hashes are de-duplicated per range and only the senders are
    kept across ranges.
    """
    senders = {}
    addresses = [c.lower() for c in contracts]
    for lo, hi in block_ranges(from_block, to_block, chunk):
        logs = rpc("eth_getLogs", [{"address": addresses, "fromBlock": hex(lo), "toBlock": hex(hi)}])
        hashes = list(dict.fromkeys(log["transactionHash"] for log in logs if not log.get("removed")))
        for h in hashes:
            tx = rpc("eth_getTransactionByHash", [h])
            sender = tx["from"].lower()
            senders[sender] = senders.get(sender, 0) + 1
        if progress:
            progress(hi)
    return senders


def write_result(path, result):
    """Write to a temporary file, then rename, so a partial scan leaves no output."""
    tmp = path + ".partial"
    with open(tmp, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def whole(minimum):
    def parse(text):
        n = int(text)
        if n < minimum:
            raise argparse.ArgumentTypeError(f"must be at least {minimum}, got {n}")
        return n

    return parse


def address(text):
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", text):
        raise argparse.ArgumentTypeError(f"not an address: {text}")
    return text.lower()


def main(argv=None, rpc=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--rpc", help="Arc RPC endpoint; defaults to LEVY_RPC_URL, which keeps a key out of shell history")
    p.add_argument("--chain-id", required=True, type=whole(1), help="the chain the endpoint must be on (Arc testnet 5042002)")
    p.add_argument("--contracts", required=True, nargs="+", type=address, help="Levy contract addresses (manager, fee router)")
    p.add_argument("--exclude", nargs="+", type=address, default=[], help="service senders, such as the keeper, to list apart")
    p.add_argument("--from-block", required=True, type=whole(0), help="first block, normally the deploy block")
    p.add_argument("--to-block", default="latest", type=lambda t: t if t == "latest" else whole(0)(t))
    p.add_argument("--chunk", type=whole(1), default=500, help="blocks per eth_getLogs request (Arc RPCs cap the range)")
    p.add_argument("--max-blocks", type=whole(1), default=2_000_000, help="refuse a longer range (about 11 days of Arc blocks)")
    p.add_argument("--out", default="unique-actors.json")
    args = p.parse_args(argv)

    if rpc is None:
        url = args.rpc or os.environ.get("LEVY_RPC_URL")
        if not url:
            p.error("set LEVY_RPC_URL or pass --rpc")
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            p.error("the RPC endpoint must be an http or https URL")
        rpc = make_rpc(url)
    chain_id = int(rpc("eth_chainId", []), 16)
    if chain_id != args.chain_id:
        p.error(f"the endpoint is on chain {chain_id}, not --chain-id {args.chain_id}")
    to_block = int(rpc("eth_blockNumber", []), 16) if args.to_block == "latest" else args.to_block
    span = to_block - args.from_block + 1
    if span < 1:
        p.error(f"--from-block {args.from_block} is after --to-block {to_block}")
    if span > args.max_blocks:
        p.error(f"{span:,} blocks is more than --max-blocks {args.max_blocks:,}; scan in parts or raise it")

    ranges_done = 0

    def progress(block):
        nonlocal ranges_done
        ranges_done += 1
        if ranges_done % 200 == 0:
            print(f"  scanned through block {block:,}", file=sys.stderr)

    print(f"Chain {chain_id}: scanning {len(args.contracts)} contracts, blocks {args.from_block:,} to {to_block:,}", file=sys.stderr)
    senders = count_senders(rpc, args.contracts, args.from_block, to_block, args.chunk, progress)
    excluded = {a: senders.pop(a) for a in args.exclude if a in senders}
    write_result(args.out, {
        "chainId": chain_id,
        "contracts": args.contracts,
        "fromBlock": args.from_block,
        "toBlock": to_block,
        "method": METHOD,
        "uniqueAddresses": len(senders),
        "transactions": sum(senders.values()),
        "addresses": dict(sorted(senders.items())),
        "excluded": dict(sorted(excluded.items())),
    })
    print(f"\nUnique transaction senders: {len(senders):,} ({sum(senders.values()):,} transactions)")
    if excluded:
        print(f"Excluded: {len(excluded)} service addresses ({sum(excluded.values()):,} transactions)")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()

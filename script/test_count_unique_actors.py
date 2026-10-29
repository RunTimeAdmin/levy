"""Tests for count-unique-actors.py against a fake RPC. Run: python script/test_count_unique_actors.py"""

import importlib.util
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    "count_unique_actors", os.path.join(os.path.dirname(__file__), "count-unique-actors.py")
)
actors = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(actors)

MANAGER = "0x" + "aa" * 20
ROUTER = "0x" + "bb" * 20
USDC = "0x" + "cc" * 20
MERCHANT = "0x" + "11" * 20
SUBSCRIBER = "0x" + "22" * 20
KEEPER = "0x" + "33" * 20


class FakeRpc:
    """Answers eth_getLogs from a list of logs and eth_getTransactionByHash from a sender map."""

    def __init__(self, logs, senders, head=1000, fail_at_block=None):
        self.logs = logs
        self.senders = senders
        self.head = head
        self.fail_at_block = fail_at_block
        self.ranges = []

    def __call__(self, method, params):
        if method == "eth_blockNumber":
            return hex(self.head)
        if method == "eth_chainId":
            return hex(5042002)
        if method == "eth_getLogs":
            f = params[0]
            lo, hi = int(f["fromBlock"], 16), int(f["toBlock"], 16)
            if self.fail_at_block is not None and lo <= self.fail_at_block <= hi:
                raise RuntimeError("RPC error")
            self.ranges.append((lo, hi))
            return [l for l in self.logs if l["address"] in f["address"] and lo <= l["block"] <= hi]
        if method == "eth_getTransactionByHash":
            return {"from": self.senders[params[0]]}
        raise AssertionError(method)


def log(address, block, tx, removed=False):
    return {"address": address, "block": block, "transactionHash": tx, "removed": removed}


class CountSenders(unittest.TestCase):
    def test_counts_each_sender_once_per_transaction(self):
        logs = [
            log(MANAGER, 10, "0xplan"),
            log(MANAGER, 20, "0xsub"),
            log(MANAGER, 20, "0xsub"),  # Subscribed and Charged in one transaction
            log(ROUTER, 20, "0xsub"),
            log(MANAGER, 600, "0xcharge1"),
            log(MANAGER, 900, "0xcharge2"),
        ]
        senders = {"0xplan": MERCHANT, "0xsub": SUBSCRIBER, "0xcharge1": KEEPER, "0xcharge2": KEEPER}
        rpc = FakeRpc(logs, senders)
        got = actors.count_senders(rpc, [MANAGER, ROUTER], 0, 1000, 500)
        self.assertEqual(got, {MERCHANT: 1, SUBSCRIBER: 1, KEEPER: 2})

    def test_ignores_logs_from_other_contracts_and_removed_logs(self):
        logs = [log(USDC, 5, "0xapprove"), log(MANAGER, 6, "0xgone", removed=True)]
        rpc = FakeRpc(logs, {"0xapprove": SUBSCRIBER, "0xgone": SUBSCRIBER})
        self.assertEqual(actors.count_senders(rpc, [MANAGER], 0, 100, 50), {})

    def test_ranges_cover_every_block_once(self):
        rpc = FakeRpc([], {})
        actors.count_senders(rpc, [MANAGER], 7, 1206, 500)
        self.assertEqual(rpc.ranges, [(7, 506), (507, 1006), (1007, 1206)])

    def test_addresses_are_matched_in_lower_case(self):
        rpc = FakeRpc([log(MANAGER, 1, "0xa")], {"0xa": "0xABCDEF" + "00" * 17})
        got = actors.count_senders(rpc, [MANAGER.upper().replace("0X", "0x")], 0, 10, 10)
        self.assertEqual(got, {"0xabcdef" + "00" * 17: 1})


class Retries(unittest.TestCase):
    def test_backs_off_on_rate_limits_then_gives_up(self):
        calls, waits = [], []

        def urlopen(req, timeout):
            calls.append(req)
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            rpc = actors.make_rpc("http://rpc", retries=3, sleep=waits.append)
            with self.assertRaises(urllib.error.HTTPError):
                rpc("eth_chainId", [])
        self.assertEqual(len(calls), 4)
        self.assertEqual(waits, [1, 2, 4])

    def test_does_not_retry_a_refusal(self):
        calls = []

        def urlopen(req, timeout):
            calls.append(req)
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

        with mock.patch.object(urllib.request, "urlopen", urlopen):
            with self.assertRaises(urllib.error.HTTPError):
                actors.make_rpc("http://rpc", sleep=lambda s: None)("eth_chainId", [])
        self.assertEqual(len(calls), 1)


class Main(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.dir.name, "out.json")

    def tearDown(self):
        self.dir.cleanup()

    def run_main(self, rpc, *extra):
        actors.main(
            ["--rpc", "x", "--chain-id", "5042002", "--contracts", MANAGER, ROUTER, "--from-block", "0", "--out", self.out, *extra],
            rpc=rpc,
        )

    def read_out(self):
        with open(self.out) as f:
            return json.load(f)

    def test_writes_the_inputs_with_the_result(self):
        rpc = FakeRpc([log(MANAGER, 3, "0xa")], {"0xa": MERCHANT}, head=999)
        self.run_main(rpc)
        result = self.read_out()
        self.assertEqual(result["chainId"], 5042002)
        self.assertEqual(result["contracts"], [MANAGER, ROUTER])
        self.assertEqual((result["fromBlock"], result["toBlock"]), (0, 999))
        self.assertIn("tx.from", result["method"])
        self.assertEqual(result["uniqueAddresses"], 1)
        self.assertEqual(result["addresses"], {MERCHANT: 1})
        self.assertEqual(result["excluded"], {})

    def test_lists_excluded_senders_apart(self):
        logs = [log(MANAGER, 3, "0xsub"), log(MANAGER, 4, "0xc1"), log(MANAGER, 5, "0xc2")]
        rpc = FakeRpc(logs, {"0xsub": SUBSCRIBER, "0xc1": KEEPER, "0xc2": KEEPER}, head=999)
        self.run_main(rpc, "--exclude", KEEPER.upper().replace("0X", "0x"))
        result = self.read_out()
        self.assertEqual(result["addresses"], {SUBSCRIBER: 1})
        self.assertEqual((result["uniqueAddresses"], result["transactions"]), (1, 1))
        self.assertEqual(result["excluded"], {KEEPER: 2})

    def test_refuses_an_endpoint_on_another_chain(self):
        rpc = FakeRpc([log(MANAGER, 3, "0xa")], {"0xa": MERCHANT}, head=999)
        with self.assertRaises(SystemExit):
            actors.main(["--rpc", "x", "--chain-id", "1", "--contracts", MANAGER, "--from-block", "0", "--out", self.out], rpc=rpc)
        self.assertEqual(rpc.ranges, [])
        self.assertFalse(os.path.exists(self.out))

    def test_refuses_a_chunk_below_one(self):
        for chunk in ("0", "-5"):
            rpc = FakeRpc([], {}, head=999)
            with self.assertRaises(SystemExit):
                self.run_main(rpc, "--chunk", chunk)
            self.assertEqual(rpc.ranges, [])

    def test_refuses_a_malformed_address_or_block(self):
        for bad in (["--contracts", "0x1234"], ["--exclude", "keeper"], ["--from-block", "-1"], ["--to-block", "-1"]):
            rpc = FakeRpc([], {}, head=999)
            with self.assertRaises(SystemExit):
                self.run_main(rpc, *bad)
            self.assertEqual(rpc.ranges, [])

    def test_reads_the_endpoint_from_the_environment(self):
        args = ["--chain-id", "5042002", "--contracts", MANAGER, "--from-block", "0", "--out", self.out]
        rpc = FakeRpc([], {}, head=9)
        with mock.patch.object(actors, "make_rpc", return_value=rpc) as make:
            with mock.patch.dict(os.environ, {"LEVY_RPC_URL": "https://rpc.example/key123"}):
                actors.main(args)
            make.assert_called_once_with("https://rpc.example/key123")
            with mock.patch.dict(os.environ, {"LEVY_RPC_URL": ""}):
                with self.assertRaises(SystemExit):
                    actors.main(args)
            with mock.patch.dict(os.environ, {"LEVY_RPC_URL": "ws://rpc.example"}):
                with self.assertRaises(SystemExit):
                    actors.main(args)
            self.assertEqual(make.call_count, 1)

    def test_no_output_when_the_scan_fails_part_way(self):
        rpc = FakeRpc([], {}, head=2000, fail_at_block=1500)
        with self.assertRaises(RuntimeError):
            self.run_main(rpc)
        self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.out + ".partial"))

    def test_refuses_a_range_over_the_limit(self):
        rpc = FakeRpc([], {}, head=5000)
        with self.assertRaises(SystemExit):
            self.run_main(rpc, "--max-blocks", "1000")
        self.assertEqual(rpc.ranges, [])


if __name__ == "__main__":
    unittest.main()

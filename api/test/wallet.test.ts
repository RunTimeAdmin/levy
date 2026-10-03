import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";

// public/wallet.js encodes calls by hand (no third-party code on the checkout
// page). Hold every hard-coded selector to the ABIs the keeper uses.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "wallet.js"), "utf-8");
const abi = (name: string) =>
  JSON.parse(readFileSync(join(here, "..", "..", "keeper", "abi", `${name}.json`), "utf-8")) as Array<{ type: string; name?: string }>;

function fn(name: string, contract: string): AbiFunction {
  const item = abi(contract).find((e) => e.type === "function" && e.name === name);
  assert.ok(item, `${name} not in ${contract} ABI`);
  return item as AbiFunction;
}

describe("wallet.js encodings match the contracts", () => {
  for (const [key, name, contract] of [
    ["approve", "approve", "MockUSDC"],
    ["allowance", "allowance", "MockUSDC"],
    ["balanceOf", "balanceOf", "MockUSDC"],
    ["subscribe", "subscribe", "SubscriptionManager"],
    ["pause", "pauseSubscription", "SubscriptionManager"],
    ["resume", "resumeSubscription", "SubscriptionManager"],
    ["cancel", "cancelSubscription", "SubscriptionManager"],
    ["createPlan", "createPlan", "SubscriptionManager"],
    ["changePlan", "changePlan", "SubscriptionManager"],
    ["subscriptions", "subscriptions", "SubscriptionManager"],
  ] as const) {
    it(`${key} selector`, () => {
      const m = src.match(new RegExp(`${key}: "(0x[0-9a-f]{8})"`));
      assert.ok(m, `no ${key} selector in wallet.js`);
      assert.equal(m[1], toFunctionSelector(fn(name, contract)));
    });
  }

  it("Subscribed topic, with subId as the first indexed topic", () => {
    const event = abi("SubscriptionManager").find((e) => e.type === "event" && e.name === "Subscribed") as AbiEvent;
    const m = src.match(/SUBSCRIBED_TOPIC = "(0x[0-9a-f]{64})"/);
    assert.ok(m);
    assert.equal(m[1], toEventSelector(event));
    assert.equal(event.inputs[0].name, "subId");
    assert.equal(event.inputs[0].indexed, true);
    // subscribe() reads the first charge time from the first word of the log data.
    const data = event.inputs.filter((i) => !i.indexed);
    assert.equal(data[0].name, "nextChargeAt");
    assert.equal(data[0].type, "uint64");
  });

  it("PlanCreated topic, with planId as the first indexed topic", () => {
    const event = abi("SubscriptionManager").find((e) => e.type === "event" && e.name === "PlanCreated") as AbiEvent;
    const m = src.match(/PLAN_CREATED_TOPIC = "(0x[0-9a-f]{64})"/);
    assert.ok(m);
    assert.equal(m[1], toEventSelector(event));
    assert.equal(event.inputs[0].name, "planId");
    assert.equal(event.inputs[0].indexed, true);
  });

  it("subscriptions() getter fields are in the order subscription() decodes", () => {
    const getter = fn("subscriptions", "SubscriptionManager");
    assert.deepEqual(getter.outputs.map((o) => o.name),
      ["subscriber", "planId", "start", "nextChargeAt", "failedAttempts", "credit", "chargeCount", "status"]);
  });

  it("createPlan takes price, cycle, trial, grace, maxFailed in that order", () => {
    assert.deepEqual(fn("createPlan", "SubscriptionManager").inputs.map((i) => i.name),
      ["price", "cycleSeconds", "trialSeconds", "graceSeconds", "maxFailed"]);
  });
});

describe("wallet.js chain names and explorer links", () => {
  // setTimeout runs at once here, so a two-minute receipt wait finishes instantly.
  const ctx: { window: { ethereum?: unknown }; setTimeout: (fn: () => void) => void } =
    { window: {}, setTimeout: (fn) => setImmediate(fn) };
  const wallet = runInNewContext(`${src}; LevyWallet`, ctx);
  const hash = `0x${"ab".repeat(32)}`;

  it("names the Arc chains, and falls back to the chain id", () => {
    assert.equal(wallet.chainName(5042), "Arc");
    assert.equal(wallet.chainName(5042002), "Arc Testnet");
    assert.equal(wallet.chainName(31337), "chain 31337");
  });

  it("quotes a plan change the way SubscriptionManager.changePlan computes it", () => {
    const now = 1_000_000;
    const month = { price: "30000000", cycleSeconds: 2_592_000 };
    const pro = { price: "60000000", cycleSeconds: 2_592_000 };
    // Paid cycle with half of it left: 15 USDC credit, so 45 USDC due on the 60 USDC plan.
    const half = { credit: 0n, chargeCount: 1n, nextChargeAt: now + 1_296_000 };
    // Spread: the result comes from the vm sandbox's realm, with a different Object prototype.
    assert.deepEqual({ ...wallet.changePlanQuote(half, month, pro, now) },
      { credit: 15_000_000n, due: 45_000_000n, creditLeft: 0n, nextChargeAt: now + 2_592_000 });
    // Downgrade with most of the cycle left: credit covers the cheaper plan and the rest carries.
    const cheap = { price: "10000000", cycleSeconds: 604_800 };
    const most = { credit: 0n, chargeCount: 1n, nextChargeAt: now + 2_160_000 };
    const q = wallet.changePlanQuote(most, month, cheap, now);
    assert.equal(q.credit, 25_000_000n);
    assert.equal(q.due, 0n);
    assert.equal(q.creditLeft, 15_000_000n);
    // An unpaid trial earns no credit: the full price is due.
    const trial = { credit: 0n, chargeCount: 0n, nextChargeAt: now + 600_000 };
    assert.equal(wallet.changePlanQuote(trial, month, pro, now).due, 60_000_000n);
    // Stored credit is spent first, and remaining time is capped at one cycle.
    const stored = { credit: 5_000_000n, chargeCount: 2n, nextChargeAt: now + 9_999_999 };
    assert.equal(wallet.changePlanQuote(stored, month, pro, now).credit, 35_000_000n);
  });

  it("turns wallet errors into plain messages", () => {
    assert.equal(wallet.friendly({ code: 4001, message: "User rejected the request." }), "You cancelled the request in your wallet.");
    assert.match(wallet.friendly({ code: -32002, message: "already pending" }), /already has a request waiting/);
    assert.match(wallet.friendly({ message: "insufficient funds for gas * price + value" }), /not have enough USDC/);
    assert.equal(wallet.friendly({ message: "something else" }), "something else");
  });

  it("shows USDC amounts exactly, never rounded to cents", () => {
    assert.equal(wallet.usdcText(29_000_000n), "$29.00");
    assert.equal(wallet.usdcText(29_500_000n), "$29.50");
    assert.equal(wallet.usdcText(29_000_001n), "$29.000001");
    assert.equal(wallet.usdcText(9_999n), "$0.009999");
    assert.equal(wallet.usdcText(1n), "$0.000001");
    assert.equal(wallet.usdcText(0n), "$0.00");
  });

  /** A fake EIP-1193 wallet: `chain` is what eth_chainId answers, `on` handles the rest. */
  function fakeWallet(chain: { id: string }, on: (method: string, params: unknown[]) => unknown) {
    ctx.window.ethereum = {
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method === "eth_requestAccounts") return ["0x00000000000000000000000000000000000000aa"];
        if (method === "eth_chainId") return chain.id;
        return on(method, params);
      },
    };
  }
  const ARC_TESTNET = "0x" + (5042002).toString(16);

  it("connects only once the wallet is really on Arc", async () => {
    const chain = { id: "0x1" };
    fakeWallet(chain, (method) => {
      if (method === "wallet_switchEthereumChain") { chain.id = ARC_TESTNET; return null; }
      throw new Error(method);
    });
    assert.equal(await wallet.connect(5042002), "0x00000000000000000000000000000000000000aa");

    // Accepts the add request but stays on the other chain: refused.
    const stuck = { id: "0x1" };
    fakeWallet(stuck, (method) => {
      if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown chain"), { code: 4902 });
      if (method === "wallet_addEthereumChain") return null;
      throw new Error(method);
    });
    await assert.rejects(wallet.connect(5042002), /still on another network/);
  });

  it("reports a transaction whose receipt never arrives as unknown, with its hash", async () => {
    const hash = "0x" + "cd".repeat(32);
    let receiptCalls = 0;
    fakeWallet({ id: ARC_TESTNET }, (method) => {
      if (method === "eth_sendTransaction") return hash;
      if (method === "eth_getTransactionReceipt") {
        receiptCalls++;
        if (receiptCalls % 2) throw new Error("RPC timeout"); // flaky RPC: not a failure either
        return null;
      }
      throw new Error(method);
    });
    let sent: string | null = null;
    const err = await wallet.approve("0xaa", "0xbb", "0xcc", 5n, (h: string) => { sent = h; }).then(
      () => null, (e: { hash?: string; unknown?: boolean; failed?: boolean }) => e);
    assert.equal(sent, hash, "the page learns the hash as soon as it is broadcast");
    assert.ok(err, "it does not resolve");
    assert.equal(err.unknown, true);
    assert.equal(err.failed, undefined);
    assert.equal(err.hash, hash);
    assert.equal(receiptCalls, 120);
  });

  it("reports a reverted transaction as failed", async () => {
    const hash = "0x" + "ef".repeat(32);
    fakeWallet({ id: ARC_TESTNET }, (method) => {
      if (method === "eth_sendTransaction") return hash;
      if (method === "eth_getTransactionReceipt") return { status: "0x0", transactionHash: hash, logs: [] };
      throw new Error(method);
    });
    await assert.rejects(wallet.approve("0xaa", "0xbb", "0xcc", 5n),
      (e: { failed?: boolean; hash?: string }) => e.failed === true && e.hash === hash);
  });

  it("points to the faucet on Arc testnet only", () => {
    assert.equal(wallet.faucet(5042002), "https://faucet.circle.com");
    assert.equal(wallet.faucet(5042), null);
  });

  it("links transactions only on chains with an explorer, and only real hashes", () => {
    assert.equal(wallet.txUrl(5042002, hash), `https://explorer.testnet.arc.io/tx/${hash}`);
    assert.equal(wallet.txUrl(31337, hash), null);
    assert.equal(wallet.txUrl(5042002, "0xtx1"), null);
    assert.equal(wallet.txUrl(5042002, `${hash}"><b>`), null);
  });
});

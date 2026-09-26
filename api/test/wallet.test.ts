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
  });
});

describe("wallet.js chain names and explorer links", () => {
  const wallet = runInNewContext(`${src}; LevyWallet`, { window: {} });
  const hash = `0x${"ab".repeat(32)}`;

  it("names the Arc chains, and falls back to the chain id", () => {
    assert.equal(wallet.chainName(5042), "Arc");
    assert.equal(wallet.chainName(5042002), "Arc Testnet");
    assert.equal(wallet.chainName(31337), "chain 31337");
  });

  it("links transactions only on chains with an explorer, and only real hashes", () => {
    assert.equal(wallet.txUrl(5042002, hash), `https://explorer.testnet.arc.io/tx/${hash}`);
    assert.equal(wallet.txUrl(31337, hash), null);
    assert.equal(wallet.txUrl(5042002, "0xtx1"), null);
    assert.equal(wallet.txUrl(5042002, `${hash}"><b>`), null);
  });
});

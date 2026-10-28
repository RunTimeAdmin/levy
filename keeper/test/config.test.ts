import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { loadConfig, redactRpcUrl } from "../src/config.js";

const REQUIRED = {
  LEVY_MANAGER_ADDRESS: "0x62a6512335d630ef19fcadb497adf98d883f77c6",
  LEVY_USDC_ADDRESS: "0x3600000000000000000000000000000000000000",
  // Placeholder, not a key anyone uses: loadConfig does not parse it.
  LEVY_KEEPER_KEY: `0x${"11".repeat(32)}`,
};
const TUNING = [
  "LEVY_CHAIN_ID", "LEVY_POLL_MS", "LEVY_WEBHOOK_POLL_MS", "LEVY_DUNNING_DAYS",
  "LEVY_LOOKBACK_BLOCKS", "LEVY_LOG_CHUNK_BLOCKS", "LEVY_MAX_SPONSORED_FAILURES",
];

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of [...Object.keys(REQUIRED), ...TUNING]) saved[k] = process.env[k];
    Object.assign(process.env, REQUIRED);
    for (const k of TUNING) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses the defaults when the tuning variables are unset or empty", () => {
    process.env.LEVY_POLL_MS = "";
    const cfg = loadConfig();
    assert.equal(cfg.chainId, 5042);
    assert.equal(cfg.pollIntervalMs, 30_000);
    assert.equal(cfg.webhookPollMs, 5_000);
    assert.deepEqual(cfg.dunningScheduleDays, [1, 3, 7]);
    assert.equal(cfg.initialLookbackBlocks, 5000);
    assert.equal(cfg.logChunkBlocks, 500);
    assert.equal(cfg.maxSponsoredFailures, 6);
  });

  it("reads valid values", () => {
    process.env.LEVY_CHAIN_ID = "5042002";
    process.env.LEVY_POLL_MS = "15000";
    process.env.LEVY_DUNNING_DAYS = "2, 4,8";
    process.env.LEVY_LOOKBACK_BLOCKS = "0";
    process.env.LEVY_LOG_CHUNK_BLOCKS = "7";
    const cfg = loadConfig();
    assert.equal(cfg.chainId, 5042002);
    assert.equal(cfg.pollIntervalMs, 15_000);
    assert.deepEqual(cfg.dunningScheduleDays, [2, 4, 8]);
    assert.equal(cfg.initialLookbackBlocks, 0);
    assert.equal(cfg.logChunkBlocks, 7);
  });

  // Each of these used to load as NaN or 0: a poll loop with no pause, a log
  // range loop that never ends, retries scheduled at NaN.
  for (const [name, value] of [
    ["LEVY_POLL_MS", "30s"],
    ["LEVY_POLL_MS", "0"],
    ["LEVY_WEBHOOK_POLL_MS", "-1"],
    ["LEVY_LOG_CHUNK_BLOCKS", "0"],
    ["LEVY_LOG_CHUNK_BLOCKS", "500.5"],
    ["LEVY_LOOKBACK_BLOCKS", "lots"],
    ["LEVY_CHAIN_ID", "arc"],
    ["LEVY_DUNNING_DAYS", "1,3,x"],
    ["LEVY_DUNNING_DAYS", "1,,7"],
    ["LEVY_DUNNING_DAYS", "1,0"],
    ["LEVY_MAX_SPONSORED_FAILURES", "0"],
  ] as const) {
    it(`refuses ${name}=${value}`, () => {
      process.env[name] = value;
      assert.throws(() => loadConfig(), new RegExp(name));
    });
  }
});

describe("redactRpcUrl", () => {
  const KEY = "k3y-0f-the-rpc-provider";

  it("cuts a key in the path or the query down to the origin", () => {
    for (const url of [
      `https://arc-testnet.g.alchemy.com/v2/${KEY}`,
      `https://lb.drpc.org/ogrpc?network=arc-testnet&dkey=${KEY}`,
      `https://user:${KEY}@rpc.example.org/`,
    ]) {
      const out = redactRpcUrl(`request failed. URL: ${url} Request body: {}`, url);
      assert.ok(!out.includes(KEY), out);
      assert.ok(out.includes(`${new URL(url).origin}/<redacted>`), out);
    }
  });

  it("leaves text alone when the URL has nothing to hide or is unset", () => {
    const text = "URL: https://rpc.testnet.arc.io";
    assert.equal(redactRpcUrl(text, "https://rpc.testnet.arc.io"), text);
    assert.equal(redactRpcUrl(text, undefined), text);
  });

  it("removes the key from a real viem transport error", async () => {
    // Nothing listens on port 9: the request fails and viem reports the URL.
    const url = `http://127.0.0.1:9/v2/${KEY}`;
    const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 2000 }) });
    const err: any = await client.getBlockNumber().then(() => assert.fail("expected an error"), (e) => e);
    assert.ok(String(err.message).includes(KEY), "viem includes the URL; the test relies on it");
    const out = redactRpcUrl(String(err.stack ?? err), url);
    assert.ok(!out.includes(KEY), out);
    assert.ok(out.includes("http://127.0.0.1:9/<redacted>"), out);
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { scheduleStep } from "../src/schedule.js";

const REQUIRED = {
  LEVY_MANAGER_ADDRESS: "0x0000000000000000000000000000000000000001",
  LEVY_USDC_ADDRESS: "0x0000000000000000000000000000000000000002",
  LEVY_KEEPER_KEY: `0x${"11".repeat(32)}`,
};
const TOUCHED = [...Object.keys(REQUIRED), "LEVY_LOG_CHUNK_BLOCKS", "LEVY_POLL_MS", "LEVY_DUNNING_DAYS", "LEVY_LOOKBACK_BLOCKS"];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

function withEnv(vars: Record<string, string>): void {
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, REQUIRED, vars);
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  it("keeps the documented defaults", () => {
    withEnv({});
    const cfg = loadConfig();
    assert.equal(cfg.chainId, 5042);
    assert.equal(cfg.pollIntervalMs, 30_000);
    assert.equal(cfg.webhookPollMs, 5_000);
    assert.equal(cfg.logChunkBlocks, 500);
    assert.equal(cfg.initialLookbackBlocks, 5000);
    assert.deepEqual(cfg.dunningScheduleDays, [1, 3, 7]);
  });

  it("accepts a lookback of zero blocks", () => {
    withEnv({ LEVY_LOOKBACK_BLOCKS: "0" });
    assert.equal(loadConfig().initialLookbackBlocks, 0);
  });

  it("refuses values the keeper cannot run on", () => {
    // 0 would loop forever in logRanges; "30s" is NaN, a busy loop against the RPC.
    for (const vars of [
      { LEVY_LOG_CHUNK_BLOCKS: "0" },
      { LEVY_LOG_CHUNK_BLOCKS: "7.5" },
      { LEVY_POLL_MS: "30s" },
      { LEVY_POLL_MS: "" },
      { LEVY_DUNNING_DAYS: "1,,7" },
      { LEVY_LOOKBACK_BLOCKS: "-1" },
    ]) {
      withEnv(vars);
      assert.throws(() => loadConfig(), new RegExp(Object.keys(vars)[0]), JSON.stringify(vars));
    }
  });
});

describe("scheduleStep", () => {
  it("is 1-based, clamps below 1, and reuses the last step past the end", () => {
    const s = [60, 300, 900];
    assert.deepEqual([0, 1, 2, 3, 4, 50].map((n) => scheduleStep(s, n)), [60, 60, 300, 900, 900, 900]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logRanges } from "../src/indexer.js";

describe("logRanges", () => {
  it("splits an inclusive block range into bounded chunks", () => {
    assert.deepEqual(logRanges(10n, 24n, 5n), [[10n, 14n], [15n, 19n], [20n, 24n]]);
    assert.deepEqual(logRanges(10n, 22n, 5n), [[10n, 14n], [15n, 19n], [20n, 22n]]);
    assert.deepEqual(logRanges(7n, 7n, 500n), [[7n, 7n]]);
    assert.deepEqual(logRanges(8n, 7n, 500n), []);
  });

  it("covers a day of Arc blocks in 500-block requests", () => {
    const ranges = logRanges(1n, 172_800n, 500n);
    assert.equal(ranges.length, 346);
    assert.ok(ranges.every(([a, b]) => b - a + 1n <= 500n));
    assert.equal(ranges.at(-1)?.[1], 172_800n);
  });
});

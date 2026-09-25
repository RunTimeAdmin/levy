import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fundsStatus } from "../src/funds.js";

describe("fundsStatus", () => {
  it("counts whole rounds of all the subscriber's charges", () => {
    assert.deepEqual(fundsStatus(35n, 10n), { cyclesCovered: 3n, low: false });
    assert.deepEqual(fundsStatus(20n, 10n), { cyclesCovered: 2n, low: false });
  });

  it("is low under two rounds, including an empty allowance", () => {
    assert.deepEqual(fundsStatus(19n, 10n), { cyclesCovered: 1n, low: true });
    assert.deepEqual(fundsStatus(0n, 10n), { cyclesCovered: 0n, low: true });
  });

  it("is never low with nothing to charge", () => {
    assert.deepEqual(fundsStatus(0n, 0n), { cyclesCovered: 0n, low: false });
  });
});

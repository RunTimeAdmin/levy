import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fundsStatus, upcomingCost, type RunwaySub } from "../src/funds.js";

const plain = (price: string): RunwaySub => ({ price, introPrice: "0", introCyclesLeft: 0, maxCycles: 0, planCycles: 0 });

describe("fundsStatus", () => {
  it("counts whole rounds of all the subscriber's charges", () => {
    assert.deepEqual(fundsStatus(35n, [plain("10")]), { perCycle: 10n, cyclesCovered: 3n, low: false });
    assert.deepEqual(fundsStatus(20n, [plain("4"), plain("6")]), { perCycle: 10n, cyclesCovered: 2n, low: false });
  });

  it("is low under two rounds, including an empty allowance", () => {
    assert.deepEqual(fundsStatus(19n, [plain("10")]), { perCycle: 10n, cyclesCovered: 1n, low: true });
    assert.deepEqual(fundsStatus(0n, [plain("10")]), { perCycle: 10n, cyclesCovered: 0n, low: true });
  });

  it("is never low with nothing to charge", () => {
    assert.deepEqual(fundsStatus(0n, []), { perCycle: 0n, cyclesCovered: 0n, low: false });
  });

  it("prices intro cycles at the intro price", () => {
    const promo: RunwaySub = { price: "10", introPrice: "1", introCyclesLeft: 1, maxCycles: 0, planCycles: 0 };
    assert.equal(upcomingCost(promo, 2), 11n);
    // One round is the $1 intro charge; two rounds need $1 + $10.
    assert.deepEqual(fundsStatus(11n, [promo]), { perCycle: 1n, cyclesCovered: 11n, low: false });
    assert.equal(fundsStatus(10n, [promo]).low, true);
  });

  it("is not low when every remaining charge of a limited plan is covered", () => {
    const last: RunwaySub = { price: "10", introPrice: "0", introCyclesLeft: 0, maxCycles: 3, planCycles: 2 };
    assert.equal(upcomingCost(last, 2), 10n);
    assert.deepEqual(fundsStatus(10n, [last]), { perCycle: 10n, cyclesCovered: 1n, low: false });
    assert.equal(fundsStatus(9n, [last]).low, true);
  });
});

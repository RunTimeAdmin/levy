import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DAY_SECONDS, checkDunningSchedule, clearDunning, nextRetryAt, recordFailure } from "../src/dunning.js";
import { LevyDb } from "../src/db.js";
import type { LevyConfig } from "../src/config.js";

const cfg = { dunningScheduleDays: [1, 3, 7] } as LevyConfig;
const NOW = 1_700_000_000;

describe("nextRetryAt", () => {
  it("schedules attempt 1 one day out", () => {
    assert.equal(nextRetryAt(1, NOW, cfg.dunningScheduleDays), NOW + DAY_SECONDS);
  });
  it("schedules attempt 2 three days out", () => {
    assert.equal(nextRetryAt(2, NOW, cfg.dunningScheduleDays), NOW + 3 * DAY_SECONDS);
  });
  it("schedules attempt 3 seven days out", () => {
    assert.equal(nextRetryAt(3, NOW, cfg.dunningScheduleDays), NOW + 7 * DAY_SECONDS);
  });
  it("clamps attempts past the schedule to the last interval", () => {
    assert.equal(nextRetryAt(10, NOW, cfg.dunningScheduleDays), NOW + 7 * DAY_SECONDS);
  });
  it("treats attempt 0 as attempt 1", () => {
    assert.equal(nextRetryAt(0, NOW, cfg.dunningScheduleDays), NOW + DAY_SECONDS);
  });
});

describe("dunning persistence", () => {
  it("recordFailure writes a retry row, clearDunning removes it", () => {
    const db = new LevyDb(":memory:");
    recordFailure(db, cfg, "42", 2, NOW);
    const due = db.dueRetries(NOW + 3 * DAY_SECONDS);
    assert.equal(due.length, 1);
    assert.equal(due[0].subId, "42");
    assert.equal(due[0].attempts, 2);
    assert.equal(due[0].nextRetryAt, NOW + 3 * DAY_SECONDS);

    // Not due yet at +1 day.
    assert.equal(db.dueRetries(NOW + DAY_SECONDS).length, 0);

    clearDunning(db, "42");
    assert.equal(db.dueRetries(NOW + 30 * DAY_SECONDS).length, 0);
    db.close();
  });
});

describe("checkDunningSchedule", () => {
  // SubscriptionManager.retryGap: 1 day after the first failure, 3 after the second, 7 after that.
  const retryGap = async (n: bigint) => BigInt((n === 1n ? 1 : n === 2n ? 3 : 7) * DAY_SECONDS);

  it("accepts the contract's own schedule and longer gaps", async () => {
    await checkDunningSchedule([1, 3, 7], retryGap);
    await checkDunningSchedule([2, 5, 10, 14], retryGap);
  });

  it("refuses a retry sooner than retryGap allows", async () => {
    await assert.rejects(checkDunningSchedule([1, 1, 7], retryGap), /after failure 2/);
    // The last interval repeats, so [1, 3] retries 3 days after the third failure.
    await assert.rejects(checkDunningSchedule([1, 3], retryGap), /after failure 3/);
  });
});

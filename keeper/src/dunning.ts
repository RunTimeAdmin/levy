import type { LevyConfig } from "./config.js";
import { LevyDb } from "./db.js";

export const DAY_SECONDS = 86_400;

/**
 * When should attempt N (1-based, the just-recorded failure count) be retried?
 * Schedule comes from config, e.g. [1, 3, 7] days. Attempts past the end of
 * the schedule reuse the last interval.
 */
export function nextRetryAt(
  failedAttempts: number,
  nowSec: number,
  scheduleDays: number[]
): number {
  const idx = Math.min(Math.max(failedAttempts, 1) - 1, scheduleDays.length - 1);
  return nowSec + scheduleDays[idx] * DAY_SECONDS;
}

/**
 * Throws if the schedule retries sooner than the contract allows. A failure
 * is recorded no sooner than retryGap(failures) after the last one, so a
 * shorter retry fails with RetryTooSoon: the schedule would say one thing and
 * the chain do another. Longer gaps are fine.
 */
export async function checkDunningSchedule(
  scheduleDays: number[],
  retryGap: (failures: bigint) => Promise<bigint>
): Promise<void> {
  // retryGap is the same from the third failure on.
  for (let n = 1; n <= Math.max(scheduleDays.length, 3); n++) {
    const days = scheduleDays[Math.min(n, scheduleDays.length) - 1];
    const gap = Number(await retryGap(BigInt(n)));
    if (days * DAY_SECONDS < gap) {
      throw new Error(
        `LEVY_DUNNING_DAYS retries ${days} day(s) after failure ${n}, but the contract records the next failure ` +
          `only ${gap / DAY_SECONDS} day(s) later (retryGap): use at least 1,3,7`
      );
    }
  }
}

/** Record a failed pull and schedule the next retry. */
export function recordFailure(
  db: LevyDb,
  cfg: LevyConfig,
  subId: string,
  failedAttempts: number,
  nowSec: number
): void {
  db.setDunning({
    subId,
    attempts: failedAttempts,
    nextRetryAt: nextRetryAt(failedAttempts, nowSec, cfg.dunningScheduleDays),
    updatedAt: nowSec,
  });
}

export function clearDunning(db: LevyDb, subId: string): void {
  db.clearDunning(subId);
}

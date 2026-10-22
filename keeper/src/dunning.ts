import type { LevyConfig } from "./config.js";
import { LevyDb } from "./db.js";
import { scheduleStep } from "./schedule.js";

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
  return nowSec + scheduleStep(scheduleDays, failedAttempts) * DAY_SECONDS;
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

/**
 * The step of a retry schedule that applies to the `attempt`-th try (1-based).
 * Tries past the end of the schedule reuse its last step; anything below 1
 * counts as the first. Shared by the dunning schedule, webhook retries and the
 * keeper's charge-error backoff.
 */
export function scheduleStep(schedule: readonly number[], attempt: number): number {
  return schedule[Math.min(Math.max(attempt, 1), schedule.length) - 1];
}

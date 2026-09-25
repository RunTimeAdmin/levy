/**
 * Allowance runway. A subscriber's USDC allowance to the SubscriptionManager
 * is one pool shared by all their Levy subscriptions, so once it runs out
 * every one of their charges fails. The keeper warns merchants while there is
 * still time to top it up.
 */

/** Warn when the allowance covers fewer than this many rounds of charges. */
export const WARN_CYCLES = 2n;
/** Re-read a subscriber's allowance at least this often (seconds). */
export const FUNDS_RECHECK_SEC = 6 * 3600;
/** Bound on subscribers checked per keeper cycle (two RPC reads each). */
export const FUNDS_CHECKS_PER_CYCLE = 50;

/**
 * `perCycle` is one charge of every chargeable subscription the subscriber
 * has (proration credit ignored, so this errs towards warning).
 */
export function fundsStatus(allowance: bigint, perCycle: bigint): { cyclesCovered: bigint; low: boolean } {
  if (perCycle <= 0n) return { cyclesCovered: 0n, low: false };
  const cyclesCovered = allowance / perCycle;
  return { cyclesCovered, low: cyclesCovered < WARN_CYCLES };
}

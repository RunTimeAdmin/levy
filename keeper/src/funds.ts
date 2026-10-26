/**
 * Allowance runway. A subscriber's USDC allowance to the SubscriptionManager
 * is one pool shared by all their Levy subscriptions, so once it runs out
 * every one of their charges fails. The keeper warns merchants while there is
 * still time to top it up.
 */

/** Warn when the allowance covers fewer than this many rounds of charges. */
export const WARN_CYCLES = 2;
/** Re-read a subscriber's allowance at least this often (seconds). */
export const FUNDS_RECHECK_SEC = 6 * 3600;
/** Bound on subscribers checked per keeper cycle (two RPC reads each). */
export const FUNDS_CHECKS_PER_CYCLE = 50;

/** What prices one subscription's next charges (a db.chargeableSubs row). */
export interface RunwaySub {
  price: string;
  introPrice: string;
  introCyclesLeft: number;
  /** 0 = no limit. */
  maxCycles: number;
  planCycles: number;
}

/** Charges left before a limited plan completes, or null when it has no limit. */
export function chargesLeft(s: RunwaySub): number | null {
  return s.maxCycles > 0 ? Math.max(s.maxCycles - s.planCycles, 0) : null;
}

/** What the subscription's next `n` charges cost: intro cycles at the intro price, none past a limited plan's last. */
export function upcomingCost(s: RunwaySub, n: number): bigint {
  const count = Math.min(n, chargesLeft(s) ?? n);
  let total = 0n;
  for (let i = 0; i < count; i++) total += BigInt(i < s.introCyclesLeft ? s.introPrice : s.price);
  return total;
}

/**
 * `perCycle` is one round: the next charge of every chargeable subscription
 * the subscriber has. Low means the allowance does not cover the next
 * WARN_CYCLES charges of all of them, so a limited plan whose remaining
 * charges are covered is never low. Proration credit is ignored, so this errs
 * towards warning.
 */
export function fundsStatus(
  allowance: bigint,
  subs: RunwaySub[]
): { perCycle: bigint; cyclesCovered: bigint; low: boolean } {
  const perCycle = subs.reduce((acc, s) => acc + upcomingCost(s, 1), 0n);
  const needed = subs.reduce((acc, s) => acc + upcomingCost(s, WARN_CYCLES), 0n);
  return {
    perCycle,
    cyclesCovered: perCycle > 0n ? allowance / perCycle : 0n,
    low: needed > 0n && allowance < needed,
  };
}

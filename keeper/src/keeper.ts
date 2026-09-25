import type { ChainClients } from "./chain.js";
import type { LevyConfig } from "./config.js";
import { LevyDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { managerAbi, usdcAbi } from "./chain.js";
import { FUNDS_CHECKS_PER_CYCLE, FUNDS_RECHECK_SEC, fundsStatus } from "./funds.js";
import { WebhookDispatcher, loadSigningKey } from "./webhooks.js";
import { decodeEventLog } from "viem";

/**
 * Retry delays after a charge that failed for a reason other than payment (a
 * revert, an RPC error): 1m, 5m, 15m, 1h, then every 6h. Payment failures go
 * through the dunning schedule instead.
 */
const ERROR_BACKOFF_SEC = [60, 300, 900, 3600, 21600];

export interface CycleReport {
  syncedLogs: number;
  charged: Array<{ subId: string; txHash: string }>;
  retried: Array<{ subId: string; txHash: string }>;
  failed: Array<{ subId: string; error: string }>;
}

/**
 * One keeper cycle:
 *  1. Sync events (subscriptions, charges, failures, transfers).
 *  2. Charge every subscription whose cycle is due.
 *  3. Retry every dunning entry whose backoff has elapsed.
 * Sends are sequential so nonces stay ordered. Webhook delivery is not part
 * of the cycle; see the delivery loop in index.ts.
 */
export class Keeper {
  private indexer: Indexer;
  readonly webhooks: WebhookDispatcher;
  /** In memory: after a restart a stuck subscription is tried once more. */
  private backoff = new Map<string, { attempts: number; nextAt: number }>();

  constructor(
    private cfg: LevyConfig,
    private clients: ChainClients,
    private db: LevyDb
  ) {
    this.webhooks = new WebhookDispatcher(db, loadSigningKey(cfg.webhookKeyPath, cfg.webhookKey), {
      allowPrivate: cfg.webhookAllowPrivate,
    });
    this.indexer = new Indexer(cfg, clients, db, this.webhooks.sink());
  }

  async runCycle(): Promise<CycleReport> {
    const report: CycleReport = { syncedLogs: 0, charged: [], retried: [], failed: [] };

    const first = await this.indexer.sync();
    report.syncedLogs = first.logs;
    // Operate on chain time: the contract enforces nextChargeAt against block
    // timestamps, and in tests chain time is warped independently of the wall clock.
    const nowSec = first.nowSec;

    const handled = new Set<string>();
    for (const sub of this.db.dueSubscriptions(nowSec)) {
      if (this.backedOff(sub.subId, nowSec)) continue;
      const r = await this.tryCharge(sub.subId);
      handled.add(sub.subId);
      if (r.ok) report.charged.push({ subId: sub.subId, txHash: r.txHash });
      else report.failed.push({ subId: sub.subId, error: r.error });
      await this.settle(sub.subId, r, nowSec);
    }

    for (const row of this.db.dueRetries(nowSec)) {
      if (handled.has(row.subId)) continue;
      const sub = this.db.getSubscription(row.subId);
      // Skip retries for subscriptions that left the chargeable set
      // (cancelled, manually paused, or auto-paused on-chain).
      if (!sub || ![0, 1, 2].includes(sub.status)) {
        this.db.clearDunning(row.subId);
        continue;
      }
      if (this.backedOff(row.subId, nowSec)) continue;
      const r = await this.tryCharge(row.subId);
      if (r.ok) report.retried.push({ subId: row.subId, txHash: r.txHash });
      else report.failed.push({ subId: row.subId, error: r.error });
      await this.settle(row.subId, r, nowSec);
    }

    // Re-sync so this cycle's own receipts land in the DB immediately. The
    // webhook events they enqueue are delivered by the separate delivery loop
    // (index.ts): charging never waits on a merchant's endpoint.
    const second = await this.indexer.sync();
    report.syncedLogs += second.logs;
    await this.checkFunds(second.nowSec);
    return report;
  }

  /**
   * Allowance runway, a bounded batch per cycle (see funds.ts). When a
   * subscriber's allowance drops below the warning level, each merchant they
   * pay gets one allowance.low webhook per affected subscription; the warning
   * repeats only after the allowance recovers and runs low again. Counts the
   * direct ERC-20 allowance only, not Permit2 allowances.
   */
  private async checkFunds(nowSec: number): Promise<void> {
    const usdc = { address: this.cfg.usdcAddress, abi: usdcAbi } as const;
    for (const subscriber of this.db.fundsCandidates(nowSec - FUNDS_RECHECK_SEC, FUNDS_CHECKS_PER_CYCLE)) {
      const subs = this.db.chargeableSubs(subscriber);
      let allowance: bigint;
      let balance: bigint;
      try {
        [allowance, balance] = (await Promise.all([
          this.clients.public.readContract({ ...usdc, functionName: "allowance", args: [subscriber, this.cfg.managerAddress] }),
          this.clients.public.readContract({ ...usdc, functionName: "balanceOf", args: [subscriber] }),
        ])) as [bigint, bigint];
      } catch {
        continue; // RPC trouble: the subscriber stays a candidate for the next cycle
      }
      const perCycle = subs.reduce((acc, s) => acc + BigInt(s.price), 0n);
      const { cyclesCovered, low } = fundsStatus(allowance, perCycle);
      const covered = Number(cyclesCovered > 1_000_000n ? 1_000_000n : cyclesCovered); // unlimited approvals
      const wasLow = this.db.getFunds(subscriber)?.low === 1;
      this.db.upsertFunds({
        subscriber,
        allowance: allowance.toString(),
        balance: balance.toString(),
        per_cycle: perCycle.toString(),
        cycles_covered: covered,
        low: low ? 1 : 0,
        checked_at: nowSec,
      });
      if (!low || wasLow) continue;
      for (const s of subs) {
        this.webhooks.enqueue("allowance.low", s.merchant, {
          subId: s.subId,
          merchant: s.merchant,
          ref: s.ref,
          subscriber,
          allowance: allowance.toString(),
          balance: balance.toString(),
          cyclesCovered: covered,
          nextChargeAt: s.nextChargeAt,
        }, nowSec);
      }
    }
  }

  private backedOff(subId: string, nowSec: number): boolean {
    const b = this.backoff.get(subId);
    return b !== undefined && nowSec < b.nextAt;
  }

  /**
   * After a charge attempt. Success or a payment failure (ChargeFailed, owned
   * by dunning) clears any backoff. Anything else (a revert, an RPC error)
   * would otherwise be retried every cycle forever: re-read the subscription
   * from chain, since a stale row is the usual cause, and back off.
   */
  private async settle(
    subId: string,
    r: { ok: true; txHash: string } | { ok: false; error: string },
    nowSec: number
  ): Promise<void> {
    if (r.ok || r.error === "ChargeFailed") {
      this.backoff.delete(subId);
      return;
    }
    await this.indexer.refreshSubscription(subId).catch(() => undefined);
    const attempts = (this.backoff.get(subId)?.attempts ?? 0) + 1;
    const delay = ERROR_BACKOFF_SEC[Math.min(attempts, ERROR_BACKOFF_SEC.length) - 1];
    this.backoff.set(subId, { attempts, nextAt: nowSec + delay });
  }

  private async tryCharge(
    subId: string
  ): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      const hash = await (this.clients.manager.write as any).charge([BigInt(subId)], {
        account: this.clients.account,
        chain: this.clients.chain,
      });
      const receipt = await this.clients.public.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        return { ok: false, error: "charge reverted" };
      }
      // charge() never reverts on payment failure; it emits ChargeFailed.
      // Read the receipt logs so the report reflects the real outcome.
      let charged = false;
      let failed = false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== this.cfg.managerAddress.toLowerCase()) continue;
        let d: any;
        try {
          d = decodeEventLog({
            abi: managerAbi,
            topics: log.topics,
            data: log.data,
          });
        } catch {
          continue;
        }
        const args = d.args as any;
        if (args?.subId !== BigInt(subId)) continue;
        if (d.eventName === "Charged") charged = true;
        if (d.eventName === "ChargeFailed") failed = true;
      }
      if (failed) return { ok: false, error: "ChargeFailed" };
      if (charged) return { ok: true, txHash: hash };
      return { ok: false, error: "no Charged event in receipt" };
    } catch (e: any) {
      return { ok: false, error: e?.shortMessage ?? e?.message ?? String(e) };
    }
  }
}

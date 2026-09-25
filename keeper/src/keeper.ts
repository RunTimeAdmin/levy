import type { ChainClients } from "./chain.js";
import type { LevyConfig } from "./config.js";
import { LevyDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { managerAbi } from "./chain.js";
import { decodeEventLog } from "viem";

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
 * Sends are sequential so nonces stay ordered.
 */
export class Keeper {
  private indexer: Indexer;

  constructor(
    private cfg: LevyConfig,
    private clients: ChainClients,
    private db: LevyDb
  ) {
    this.indexer = new Indexer(cfg, clients, db);
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
      const r = await this.tryCharge(sub.subId);
      handled.add(sub.subId);
      if (r.ok) report.charged.push({ subId: sub.subId, txHash: r.txHash });
      else report.failed.push({ subId: sub.subId, error: r.error });
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
      const r = await this.tryCharge(row.subId);
      if (r.ok) report.retried.push({ subId: row.subId, txHash: r.txHash });
      else report.failed.push({ subId: row.subId, error: r.error });
    }

    // Re-sync so this cycle's own receipts land in the DB immediately.
    const second = await this.indexer.sync();
    report.syncedLogs += second.logs;
    return report;
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

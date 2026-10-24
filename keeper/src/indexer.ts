import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import type { ChainClients } from "./chain.js";
import { managerAbi } from "./chain.js";
import type { LevyConfig } from "./config.js";
import { LevyDb, Status } from "./db.js";
import { clearDunning, recordFailure } from "./dunning.js";
import { buildWebhookEvents, type WebhookSink } from "./webhooks.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const APPROVAL_EVENT = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
);

const SYNC_KEY = "manager_events_from_block";

// topic0 -> event name, built once from the contract ABI.
const TOPIC_TO_NAME = new Map<string, string>();
for (const entry of managerAbi as any[]) {
  if (entry.type === "event") TOPIC_TO_NAME.set(toEventSelector(entry), entry.name);
}
const NAME_TO_ABI = new Map<string, any>(
  (managerAbi as any[]).filter((e: any) => e.type === "event").map((e: any) => [e.name, e])
);

/**
 * Inclusive [from, to] block ranges of at most `size` blocks. RPCs reject large
 * eth_getLogs ranges, and a keeper that was down for a day is ~170k blocks behind.
 */
export function logRanges(from: bigint, to: bigint, size: bigint): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    out.push([start, end]);
  }
  return out;
}

interface RawLog {
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

/**
 * Pulls SubscriptionManager events and USDC Transfer events into the DB.
 * Subscription rows are hydrated from chain state (single source of truth);
 * events drive charges, failures, and dunning.
 */
export class Indexer {
  constructor(
    private cfg: LevyConfig,
    private clients: ChainClients,
    private db: LevyDb,
    private onEvent?: WebhookSink
  ) {}

  /**
   * Sync all new logs into the DB. `nowSec` is the chain-head timestamp the
   * caller is operating on; failure records are stamped with it so dunning
   * math agrees with due math (and with warped chain time in tests).
   */
  async sync(): Promise<{ fromBlock: bigint; toBlock: bigint; logs: number; nowSec: number }> {
    // Use getBlock("latest") rather than getBlockNumber(): anvil's
    // eth_blockNumber can go stale after evm_increaseTime, while the block
    // itself is correct. On a real chain both agree.
    const head = await this.clients.public.getBlock({ blockTag: "latest" });
    const latest = head.number;
    // nowSec is the chain-head timestamp the caller operates on; failure
    // records are stamped with it so dunning math agrees with due math
    // (and with warped chain time in tests).
    const nowSec = Number(head.timestamp);
    const stored = this.db.getSync(SYNC_KEY);
    const lookback = BigInt(this.cfg.initialLookbackBlocks);
    const fromBlock = stored
      ? BigInt(stored)
      : latest > lookback
        ? latest - lookback
        : 0n;
    const toBlock = latest;
    if (fromBlock > toBlock) return { fromBlock, toBlock, logs: 0, nowSec };

    // Chunked, and the cursor moves after each chunk: a failure part-way
    // through a long catch-up loses at most one chunk of progress.
    let count = 0;
    for (const [from, to] of logRanges(fromBlock, toBlock, BigInt(this.cfg.logChunkBlocks))) {
      const logs = await this.fetchLogs(from, to);
      for (const log of logs) {
        await this.handleLog(log, nowSec);
      }
      this.db.setSync(SYNC_KEY, (to + 1n).toString());
      count += logs.length;
    }
    return { fromBlock, toBlock, logs: count, nowSec };
  }

  /**
   * One chunk of the logs the keeper uses: every SubscriptionManager event,
   * plus USDC Transfers into or out of the manager and Approvals to it. Never
   * every USDC log: on Arc USDC is the gas token, so an unfiltered query
   * returns so many logs that providers refuse it (they cap results per call).
   */
  private async fetchLogs(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    const pub = this.clients.public;
    const usdc = this.cfg.usdcAddress;
    const manager = this.cfg.managerAddress;
    // One at a time: four parallel queries per chunk trip public RPC rate limits.
    const batches = [
      await pub.getLogs({ address: manager, fromBlock, toBlock }),
      await pub.getLogs({ address: usdc, event: TRANSFER_EVENT, args: { to: manager }, fromBlock, toBlock }),
      await pub.getLogs({ address: usdc, event: TRANSFER_EVENT, args: { from: manager }, fromBlock, toBlock }),
      await pub.getLogs({ address: usdc, event: APPROVAL_EVENT, args: { spender: manager }, fromBlock, toBlock }),
    ];
    // Back into chain order, so events are handled as they happened.
    return (batches.flat() as unknown as RawLog[]).sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
    );
  }

  private async handleLog(log: RawLog, nowSec: number): Promise<void> {
    if (log.address.toLowerCase() === this.cfg.usdcAddress.toLowerCase()) {
      // A new approval to the manager (a top-up): recheck that subscriber's
      // allowance runway on the next cycle.
      if (log.topics[0] === toEventSelector(APPROVAL_EVENT)) {
        if (BigInt(log.topics[2]) === BigInt(this.cfg.managerAddress)) {
          this.db.markFundsStale(`0x${log.topics[1].slice(26)}`);
        }
        return;
      }
      // Otherwise only Transfer events are movements.
      if (log.topics[0] !== toEventSelector(TRANSFER_EVENT)) return;
      // USDC into or out of the manager. Dedup happens at query time (see db.dedupedTransfers).
      this.db.insertTransfer({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        fromAddr: `0x${log.topics[1].slice(26)}`,
        toAddr: `0x${log.topics[2].slice(26)}`,
        amount: BigInt(log.data).toString(),
        blockNumber: Number(log.blockNumber),
      });
      return;
    }

    const name = TOPIC_TO_NAME.get(log.topics[0]);
    if (!name) return; // not one of ours (shouldn't happen with the address filter)
    const abi = NAME_TO_ABI.get(name)!;
    const decoded = decodeEventLog({
      abi: [abi],
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data,
    }) as { args: Record<string, any> };
    await this.handleManagerEvent(name, decoded.args as any, log, nowSec);
  }

  private async handleManagerEvent(
    name: string,
    args: Record<string, any>,
    log: RawLog,
    nowSec: number
  ): Promise<void> {
    if (name === "PlanCreated") {
      await this.refreshPlan((args.planId as bigint).toString());
      return;
    }
    if (args.subId === undefined) return;
    const subId = (args.subId as bigint).toString();
    let dunningNextRetryAt: number | undefined;
    switch (name) {
      case "Resumed":
        // Resume resets failedAttempts on-chain and bills from now; a stale
        // retry row would hold the sub out of the due sweep until its old time.
        clearDunning(this.db, subId);
        await this.refreshSubscription(subId);
        break;
      case "Subscribed":
      case "Paused":
      case "Cancelled":
      case "PlanChanged":
      case "AutoPaused":
        await this.refreshSubscription(subId);
        break;
      case "Charged": {
        this.db.insertCharge({
          subId,
          amount: (args.amount as bigint).toString(),
          fee: (args.fee as bigint).toString(),
          invoiceRef: args.invoiceRef as string,
          txHash: log.transactionHash,
          blockNumber: Number(log.blockNumber),
          chargeCount: Number(args.chargeCount as bigint),
        });
        clearDunning(this.db, subId);
        await this.refreshSubscription(subId);
        // The charge spent allowance: recheck the runway next cycle.
        const payer = this.db.getSubscription(subId)?.subscriber;
        if (payer) this.db.markFundsStale(payer);
        break;
      }
      case "ChargeFailed": {
        const attempts = Number(args.failedAttempts as bigint);
        this.db.insertFailure(subId, attempts, log.transactionHash, Number(log.blockNumber), nowSec);
        recordFailure(this.db, this.cfg, subId, attempts, nowSec);
        await this.refreshSubscription(subId);
        dunningNextRetryAt = this.db.getDunning(subId)?.nextRetryAt;
        break;
      }
    }
    this.emitWebhookEvents(name, args, log, subId, nowSec, dunningNextRetryAt);
  }

  /** Fan contract events out to merchant webhooks (no-op when no sink). */
  private emitWebhookEvents(
    name: string,
    args: Record<string, any>,
    log: RawLog,
    subId: string,
    nowSec: number,
    dunningNextRetryAt?: number
  ): void {
    if (!this.onEvent) return;
    const sub = this.db.getSubscription(subId);
    if (!sub) return;
    const merchant = sub.merchant;
    for (const e of buildWebhookEvents(name, args, log, { merchant, ref: sub.ref ?? null, dunningNextRetryAt })) {
      this.onEvent(e.type, merchant, e.payload, nowSec);
    }
  }

  /** Re-read one subscription (and its plan) from chain into the DB. */
  async refreshSubscription(subId: string): Promise<void> {
    // viem returns structs as plain arrays here; index positionally.
    // Subscription: [subscriber, planId, start, nextChargeAt, failedAttempts, credit, chargeCount, status]
    // Plan: [merchant, price, cycleSeconds, trialSeconds, graceSeconds, maxFailed, exists]
    const sub = (await this.clients.manager.read.subscriptions([BigInt(subId)])) as any[];
    if (sub[0] === "0x0000000000000000000000000000000000000000") return;
    const paused = Number(sub[7]) === Status.PAUSED;
    const [plan, ref, pausedByMerchant] = (await Promise.all([
      this.clients.manager.read.plans([sub[1]]),
      this.clients.manager.read.subscriptionRef([BigInt(subId)]),
      paused ? this.clients.manager.read.pausedByMerchant([BigInt(subId)]) : false,
    ])) as [any[], `0x${string}`, boolean];
    this.upsertPlan((sub[1] as bigint).toString(), plan);
    this.db.upsertSubscription({
      subId,
      subscriber: sub[0] as string,
      planId: (sub[1] as bigint).toString(),
      merchant: plan[0] as string,
      price: (plan[1] as bigint).toString(),
      cycleSeconds: Number(plan[2] as bigint),
      status: Number(sub[7]),
      nextChargeAt: Number(sub[3] as bigint),
      failedAttempts: Number(sub[4] as bigint),
      ref: /^0x0{64}$/.test(ref) ? null : ref,
      pausedByMerchant: pausedByMerchant ? 1 : 0,
    });
  }

  /** Re-read one plan from chain into the DB. */
  async refreshPlan(planId: string): Promise<void> {
    const plan = (await this.clients.manager.read.plans([BigInt(planId)])) as any[];
    if (plan[6]) this.upsertPlan(planId, plan); // plan[6] = exists
  }

  // Plan: [merchant, price, cycleSeconds, trialSeconds, graceSeconds, maxFailed, exists]
  private upsertPlan(planId: string, plan: any[]): void {
    this.db.upsertPlan({
      planId,
      merchant: plan[0] as string,
      price: (plan[1] as bigint).toString(),
      cycleSeconds: Number(plan[2] as bigint),
      trialSeconds: Number(plan[3] as bigint),
      maxFailed: Number(plan[5]),
    });
  }

  /** Backfill every known plan and subscription (used on first boot). */
  async backfillAll(): Promise<number> {
    const plans = Number(await this.clients.manager.read.planCount());
    for (let i = 1; i <= plans; i++) {
      await this.refreshPlan(String(i));
    }
    const count = Number(await this.clients.manager.read.subCount());
    for (let i = 1; i <= count; i++) {
      await this.refreshSubscription(String(i));
    }
    return count;
  }
}

export { TRANSFER_EVENT };

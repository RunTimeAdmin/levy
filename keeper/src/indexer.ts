import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import type { ChainClients } from "./chain.js";
import { managerAbi } from "./chain.js";
import type { LevyConfig } from "./config.js";
import { LevyDb } from "./db.js";
import { clearDunning, recordFailure } from "./dunning.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
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
    private db: LevyDb
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

    const logs = (await this.clients.public.getLogs({
      address: [this.cfg.managerAddress, this.cfg.usdcAddress],
      fromBlock,
      toBlock,
    })) as unknown as RawLog[];

    for (const log of logs) {
      await this.handleLog(log, nowSec);
    }
    this.db.setSync(SYNC_KEY, (toBlock + 1n).toString());
    return { fromBlock, toBlock, logs: logs.length, nowSec };
  }

  private async handleLog(log: RawLog, nowSec: number): Promise<void> {
    if (log.address.toLowerCase() === this.cfg.usdcAddress.toLowerCase()) {
      // Only Transfer events; Approval and friends share the address but are
      // not movements.
      if (log.topics[0] !== toEventSelector(TRANSFER_EVENT)) return;
      // Raw USDC movement. Dedup happens at query time (see db.dedupedTransfers).
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
    // Events like PlanCreated carry no subId; they need no indexing work.
    if (args.subId === undefined) return;
    const subId = (args.subId as bigint).toString();
    switch (name) {
      case "Subscribed":
      case "Paused":
      case "Resumed":
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
        break;
      }
      case "ChargeFailed": {
        const attempts = Number(args.failedAttempts as bigint);
        this.db.insertFailure(subId, attempts, log.transactionHash, Number(log.blockNumber), nowSec);
        recordFailure(this.db, this.cfg, subId, attempts, nowSec);
        await this.refreshSubscription(subId);
        break;
      }
    }
  }

  /** Re-read one subscription (and its plan) from chain into the DB. */
  async refreshSubscription(subId: string): Promise<void> {
    // viem returns structs as plain arrays here; index positionally.
    // Subscription: [subscriber, planId, start, nextChargeAt, failedAttempts, credit, chargeCount, status]
    // Plan: [merchant, price, cycleSeconds, trialSeconds, graceSeconds, maxFailed, exists]
    const sub = (await this.clients.manager.read.subscriptions([BigInt(subId)])) as any[];
    if (sub[0] === "0x0000000000000000000000000000000000000000") return;
    const plan = (await this.clients.manager.read.plans([sub[1]])) as any[];
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
    });
  }

  /** Backfill every known subscription (used on first boot). */
  async backfillAll(): Promise<number> {
    const count = Number(await this.clients.manager.read.subCount());
    for (let i = 1; i <= count; i++) {
      await this.refreshSubscription(String(i));
    }
    return count;
  }
}

export { TRANSFER_EVENT };

import { DatabaseSync } from "node:sqlite";

/** Subscription status enum, mirrors SubscriptionManager.Status. */
export const Status = {
  TRIAL: 0,
  ACTIVE: 1,
  PAST_DUE: 2,
  PAUSED: 3,
  CANCELLED: 4,
} as const;

/** States that can start a fresh charge cycle. PAST_DUE is deliberately
 *  excluded: once a charge fails, retries go through the dunning schedule,
 *  not the every-cycle due sweep. */
export const DUE_CHARGEABLE = [Status.TRIAL, Status.ACTIVE];

export interface DbSubscription {
  subId: string;
  subscriber: string;
  planId: string;
  merchant: string;
  price: string;
  cycleSeconds: number;
  status: number;
  nextChargeAt: number; // unix seconds
  failedAttempts: number;
}

export interface DbCharge {
  subId: string;
  amount: string;
  fee: string;
  invoiceRef: string;
  txHash: string;
  blockNumber: number;
  chargeCount: number;
}

export interface DunningRow {
  subId: string;
  attempts: number;
  nextRetryAt: number; // unix seconds
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  subId TEXT PRIMARY KEY,
  subscriber TEXT NOT NULL,
  planId TEXT NOT NULL,
  merchant TEXT NOT NULL,
  price TEXT NOT NULL,
  cycleSeconds INTEGER NOT NULL,
  status INTEGER NOT NULL,
  nextChargeAt INTEGER NOT NULL,
  failedAttempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subId TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  invoiceRef TEXT NOT NULL,
  txHash TEXT NOT NULL,
  blockNumber INTEGER NOT NULL,
  chargeCount INTEGER NOT NULL,
  UNIQUE (txHash, chargeCount)
);
CREATE TABLE IF NOT EXISTS charge_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subId TEXT NOT NULL,
  failedAttempts INTEGER NOT NULL,
  txHash TEXT NOT NULL,
  blockNumber INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dunning (
  subId TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  nextRetryAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
-- Raw USDC Transfer events. PRIMARY KEY on (txHash, logIndex) stops the same
-- log being processed twice. Cross-interface duplicates (EIP-7708: the same
-- movement emitted once by the native layer and once by the ERC-20 face, same
-- txHash, different logIndex) are collapsed by dedupedTransfers(), never by
-- deleting rows.
CREATE TABLE IF NOT EXISTS usdc_transfers (
  txHash TEXT NOT NULL,
  logIndex INTEGER NOT NULL,
  fromAddr TEXT NOT NULL,
  toAddr TEXT NOT NULL,
  amount TEXT NOT NULL,
  blockNumber INTEGER NOT NULL,
  PRIMARY KEY (txHash, logIndex)
);
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class LevyDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- subscriptions ----

  upsertSubscription(s: DbSubscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (subId, subscriber, planId, merchant, price, cycleSeconds, status, nextChargeAt, failedAttempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subId) DO UPDATE SET
           planId = excluded.planId, merchant = excluded.merchant,
           price = excluded.price, cycleSeconds = excluded.cycleSeconds,
           status = excluded.status, nextChargeAt = excluded.nextChargeAt,
           failedAttempts = excluded.failedAttempts`
      )
      .run(
        s.subId, s.subscriber, s.planId, s.merchant, s.price,
        s.cycleSeconds, s.status, s.nextChargeAt, s.failedAttempts
      );
  }

  getSubscription(subId: string): DbSubscription | undefined {
    return this.db
      .prepare(`SELECT * FROM subscriptions WHERE subId = ?`)
      .get(subId) as DbSubscription | undefined;
  }

  /** Subscriptions whose next charge is due right now. Subs with an active
   *  dunning row are excluded: their retries are owned by the dunning
   *  schedule, not the every-cycle due sweep. */
  dueSubscriptions(nowSec: number): DbSubscription[] {
    return this.db
      .prepare(
        `SELECT s.* FROM subscriptions s
         LEFT JOIN dunning d ON d.subId = s.subId
         WHERE s.status IN (${DUE_CHARGEABLE.join(",")})
           AND s.nextChargeAt <= ?
           AND d.subId IS NULL
         ORDER BY s.nextChargeAt ASC`
      )
      .all(nowSec) as unknown as DbSubscription[];
  }

  // ---- charges ----

  insertCharge(c: DbCharge): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO charges
           (subId, amount, fee, invoiceRef, txHash, blockNumber, chargeCount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.subId, c.amount, c.fee, c.invoiceRef, c.txHash, c.blockNumber, c.chargeCount);
    return r.changes > 0;
  }

  insertFailure(subId: string, failedAttempts: number, txHash: string, blockNumber: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO charge_failures (subId, failedAttempts, txHash, blockNumber, at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(subId, failedAttempts, txHash, blockNumber, at);
  }

  // ---- dunning ----

  setDunning(row: DunningRow): void {
    this.db
      .prepare(
        `INSERT INTO dunning (subId, attempts, nextRetryAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (subId) DO UPDATE SET
           attempts = excluded.attempts,
           nextRetryAt = excluded.nextRetryAt,
           updatedAt = excluded.updatedAt`
      )
      .run(row.subId, row.attempts, row.nextRetryAt, row.updatedAt);
  }

  clearDunning(subId: string): void {
    this.db.prepare(`DELETE FROM dunning WHERE subId = ?`).run(subId);
  }

  dueRetries(nowSec: number): DunningRow[] {
    return this.db
      .prepare(`SELECT * FROM dunning WHERE nextRetryAt <= ? ORDER BY nextRetryAt ASC`)
      .all(nowSec) as unknown as DunningRow[];
  }

  // ---- transfers (EIP-7708 dedup) ----

  insertTransfer(t: {
    txHash: string; logIndex: number; fromAddr: string; toAddr: string;
    amount: string; blockNumber: number;
  }): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO usdc_transfers
           (txHash, logIndex, fromAddr, toAddr, amount, blockNumber)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(t.txHash, t.logIndex, t.fromAddr, t.toAddr, t.amount, t.blockNumber);
    return r.changes > 0;
  }

  /**
   * Transfers with cross-interface duplicates collapsed. Two rows from the
   * same txHash with identical from/to/amount are treated as one economic
   * movement (the EIP-7708 native-layer + ERC-20-face duality).
   *
   * LIMITATION: this also collapses two genuinely distinct but identical
   * transfers inside one transaction (same from/to/amount, different
   * logIndex). That is accepted because:
   *  1. the indexer watches only the ERC-20 USDC interface, so the
   *     native/ERC-20 double-emit this guards against cannot occur in
   *     practice from our own indexing;
   *  2. transfer rows are accounting visibility only — charge truth comes
   *     from SubscriptionManager Charged/ChargeFailed events, never from
   *     transfer sums.
   * Do not use dedupedTransfers() for balance reconciliation.
   */
  dedupedTransfers(): Array<{
    txHash: string; fromAddr: string; toAddr: string; amount: string; blockNumber: number;
  }> {
    return this.db
      .prepare(
        `SELECT txHash, fromAddr, toAddr, amount, MIN(blockNumber) AS blockNumber
         FROM usdc_transfers
         GROUP BY txHash, fromAddr, toAddr, amount`
      )
      .all() as Array<{
      txHash: string; fromAddr: string; toAddr: string; amount: string; blockNumber: number;
    }>;
  }

  // ---- sync state ----

  getSync(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM sync_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSync(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }
}

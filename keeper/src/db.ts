import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Subscription status enum, mirrors SubscriptionManager.Status. */
export const Status = {
  TRIAL: 0,
  ACTIVE: 1,
  PAST_DUE: 2,
  PAUSED: 3,
  CANCELLED: 4,
  COMPLETED: 5,
} as const;

/** States that can start a fresh charge cycle. PAST_DUE is deliberately
 *  excluded: once a charge fails, retries go through the dunning schedule,
 *  not the every-cycle due sweep. */
export const DUE_CHARGEABLE = [Status.TRIAL, Status.ACTIVE];
/** States the contract will charge in; PAST_DUE retries are driven by dunning. */
export const CHARGEABLE = [Status.TRIAL, Status.ACTIVE, Status.PAST_DUE];

export interface DbPlan {
  planId: string;
  merchant: string;
  price: string; // 6-decimal USDC units
  cycleSeconds: number;
  trialSeconds: number;
  maxFailed: number;
  /** 1 while the merchant has retired the plan: no new subscriptions or plan changes into it. */
  retired?: number;
  /** 1 when its subscriptions may move to a new wallet. */
  transferable?: number;
  /** Cycles billed before a subscription completes; 0 = no limit. */
  maxCycles?: number;
  /** 6-decimal USDC; billed for a subscription's first introCycles cycles. "0" when none. */
  introPrice?: string;
  introCycles?: number;
}

/** A merchant account whose owner or payout changed on-chain (see SubscriptionManager.ownerOf). */
export interface DbAccount {
  account: string;
  owner: string;
  /** Fixed payout address, or null when the account's share follows its owner. */
  payout: string | null;
  pendingOwner: string | null;
}

export interface DbFunds {
  subscriber: string;
  allowance: string; // USDC units approved to the manager
  balance: string; // USDC units held
  per_cycle: string; // one charge of each chargeable subscription, summed
  cycles_covered: number;
  low: number; // 1 while the allowance covers too few rounds (see funds.ts)
  checked_at: number; // chain time; 0 = recheck next cycle
}

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
  /** Merchant's reference from subscribe (bytes32 hex), null when none. */
  ref?: string | null;
  /** 1 while paused by the merchant, the only pause the merchant may resume. */
  pausedByMerchant?: number;
  /** Intro-priced cycles left (0 unless the plan has intro pricing). */
  introCyclesLeft?: number;
  /** Cycles billed on the current plan (kept only for plans with a cycle limit). */
  planCycles?: number;
  /** The wallet the subscriber proposed to move the subscription to, until it accepts. */
  pendingTransfer?: string | null;
}

/** A chargeable subscription with the terms that price its next charges. */
export interface ChargeableSub {
  subId: string;
  merchant: string;
  price: string;
  nextChargeAt: number;
  ref: string | null;
  introCyclesLeft: number;
  planCycles: number;
  introPrice: string;
  maxCycles: number;
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

export interface WebhookRow {
  id: number;
  merchant: string;
  url: string;
  /** JSON array of subscribed event types. */
  events: string;
  active: number; // 0 | 1
  created_at: number;
}

export type DeliveryStatus = "pending" | "sent" | "failed" | "dead";

export interface DeliveryRow {
  id: number;
  webhook_id: number;
  event_type: string;
  /** Canonical JSON payload that was (or will be) POSTed. */
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  next_retry_at: number; // unix seconds
  created_at: number; // unix seconds
  last_error: string | null;
  /** The keeper's MAC over the row (WebhookDispatcher); rows without a valid one are never sent. */
  mac: string | null;
  /** `txHash:logIndex` of the chain event reported; null for allowance.low and older rows. */
  event_key: string | null;
}

const SCHEMA = `
-- On-chain plan registry mirror, including plans nobody has subscribed to yet.
CREATE TABLE IF NOT EXISTS plans (
  planId TEXT PRIMARY KEY,
  merchant TEXT NOT NULL,
  price TEXT NOT NULL,
  cycleSeconds INTEGER NOT NULL,
  trialSeconds INTEGER NOT NULL,
  maxFailed INTEGER NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0,
  transferable INTEGER NOT NULL DEFAULT 0,
  maxCycles INTEGER NOT NULL DEFAULT 0,
  introPrice TEXT NOT NULL DEFAULT '0',
  introCycles INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plans_merchant ON plans (merchant COLLATE NOCASE);
-- Merchant accounts whose owner or payout changed on-chain. A plan's merchant
-- is its account; an account with no row owns itself and is paid itself.
CREATE TABLE IF NOT EXISTS merchant_accounts (
  account TEXT PRIMARY KEY COLLATE NOCASE,
  owner TEXT NOT NULL,
  payout TEXT,
  pendingOwner TEXT
);
CREATE TABLE IF NOT EXISTS subscriptions (
  subId TEXT PRIMARY KEY,
  subscriber TEXT NOT NULL,
  planId TEXT NOT NULL,
  merchant TEXT NOT NULL,
  price TEXT NOT NULL,
  cycleSeconds INTEGER NOT NULL,
  status INTEGER NOT NULL,
  nextChargeAt INTEGER NOT NULL,
  failedAttempts INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  pausedByMerchant INTEGER NOT NULL DEFAULT 0,
  introCyclesLeft INTEGER NOT NULL DEFAULT 0,
  planCycles INTEGER NOT NULL DEFAULT 0,
  pendingTransfer TEXT
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
CREATE INDEX IF NOT EXISTS idx_charge_failures_tx ON charge_failures (txHash);
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
-- Merchant webhook endpoints. "events" is a JSON array of subscribed event
-- types (see WEBHOOK_EVENTS in webhooks.ts).
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
-- Outbound webhook delivery attempts. A delivery starts pending, moves to
-- sent on HTTP 2xx, failed while retries remain, and dead after 24h of
-- failures (dead-letter). "payload" is the exact canonical JSON that is POSTed.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL, -- webhooks(id); no FK so deliveries survive webhook deletion (they dead-letter)
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due
  ON webhook_deliveries (status, next_retry_at);
-- Allowance runway per subscriber (the allowance is shared by all their
-- subscriptions). Written by the keeper's funds check.
CREATE TABLE IF NOT EXISTS subscriber_funds (
  subscriber TEXT PRIMARY KEY COLLATE NOCASE,
  allowance TEXT NOT NULL,
  balance TEXT NOT NULL,
  per_cycle TEXT NOT NULL,
  cycles_covered INTEGER NOT NULL,
  low INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
-- API sign-in: an issued EIP-4361 message awaiting its signature. Single use.
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry ON auth_challenges (expires_at);
-- API sessions. Only the SHA-256 of the bearer token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
`;

/** The deployment a database belongs to (LevyDb.bindDeployment). */
export function deploymentId(chainId: number, manager: string, usdc: string): string {
  return `${chainId}:${manager.toLowerCase()}:${usdc.toLowerCase()}`;
}

export class LevyDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Databases created before these columns existed.
    this.addColumns("subscriptions", {
      ref: "TEXT",
      pausedByMerchant: "INTEGER NOT NULL DEFAULT 0",
      introCyclesLeft: "INTEGER NOT NULL DEFAULT 0",
      planCycles: "INTEGER NOT NULL DEFAULT 0",
      pendingTransfer: "TEXT",
    });
    this.addColumns("plans", {
      retired: "INTEGER NOT NULL DEFAULT 0",
      transferable: "INTEGER NOT NULL DEFAULT 0",
      maxCycles: "INTEGER NOT NULL DEFAULT 0",
      introPrice: "TEXT NOT NULL DEFAULT '0'",
      introCycles: "INTEGER NOT NULL DEFAULT 0",
    });
    this.addColumns("webhook_deliveries", { mac: "TEXT", event_key: "TEXT" });
    // One delivery per chain event, webhook and type (enqueueDelivery). Rows
    // without an event key never clash: SQLite counts NULLs as distinct.
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_event ON webhook_deliveries (webhook_id, event_type, event_key)"
    );
    // The API server may hold the same file open; wait instead of failing
    // on a locked database during brief concurrent writes.
    this.db.exec("PRAGMA busy_timeout = 5000");
    // WAL: the API's small writes (sign-in, webhook config) never block the
    // keeper's reads, and readers never block writers.
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  private addColumns(table: string, columns: Record<string, string>): void {
    const have = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  // ---- subscriptions ----

  /** The subscriber is updated too: a subscription can move to a new wallet. */
  upsertSubscription(s: DbSubscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (subId, subscriber, planId, merchant, price, cycleSeconds, status, nextChargeAt, failedAttempts, ref,
            pausedByMerchant, introCyclesLeft, planCycles, pendingTransfer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subId) DO UPDATE SET
           subscriber = excluded.subscriber,
           planId = excluded.planId, merchant = excluded.merchant,
           price = excluded.price, cycleSeconds = excluded.cycleSeconds,
           status = excluded.status, nextChargeAt = excluded.nextChargeAt,
           failedAttempts = excluded.failedAttempts, ref = excluded.ref,
           pausedByMerchant = excluded.pausedByMerchant, introCyclesLeft = excluded.introCyclesLeft,
           planCycles = excluded.planCycles, pendingTransfer = excluded.pendingTransfer`
      )
      .run(
        s.subId, s.subscriber, s.planId, s.merchant, s.price,
        s.cycleSeconds, s.status, s.nextChargeAt, s.failedAttempts, s.ref ?? null,
        s.pausedByMerchant ?? 0, s.introCyclesLeft ?? 0, s.planCycles ?? 0, s.pendingTransfer ?? null
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

  /** Ignores a failure already recorded, as when a chunk of logs is handled twice. */
  insertFailure(subId: string, failedAttempts: number, txHash: string, blockNumber: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO charge_failures (subId, failedAttempts, txHash, blockNumber, at)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM charge_failures WHERE txHash = ? AND subId = ? AND failedAttempts = ?
         )`
      )
      .run(subId, failedAttempts, txHash, blockNumber, at, txHash, subId, failedAttempts);
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

  getDunning(subId: string): DunningRow | undefined {
    return this.db
      .prepare(`SELECT * FROM dunning WHERE subId = ?`)
      .get(subId) as DunningRow | undefined;
  }

  /** Dunning queue with subscription context, for the API dashboard. */
  listDunning(merchant?: string): Array<DunningRow & {
    subscriber: string; planId: string; price: string; status: number;
  }> {
    const where = merchant ? `WHERE s.merchant = ? COLLATE NOCASE` : "";
    const params: Array<string | number | null> = merchant ? [merchant] : [];
    return this.db
      .prepare(
        `SELECT d.*, s.subscriber, s.planId, s.price, s.status
         FROM dunning d JOIN subscriptions s ON s.subId = d.subId
         ${where} ORDER BY d.nextRetryAt ASC`
      )
      .all(...params) as unknown as Array<DunningRow & {
      subscriber: string; planId: string; price: string; status: number;
    }>;
  }

  // ---- charges (read side for the API) ----

  listCharges(filter: { subId?: string; merchant?: string } = {}): Array<DbCharge & {
    subscriber: string; merchant: string; id: number;
  }> {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.subId) { clauses.push(`c.subId = ?`); params.push(filter.subId); }
    if (filter.merchant) { clauses.push(`s.merchant = ? COLLATE NOCASE`); params.push(filter.merchant); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT c.id, c.subId, c.amount, c.fee, c.invoiceRef, c.txHash,
                c.blockNumber, c.chargeCount, s.subscriber, s.merchant
         FROM charges c LEFT JOIN subscriptions s ON s.subId = c.subId
         ${where} ORDER BY c.id DESC`
      )
      .all(...params) as unknown as Array<DbCharge & {
      subscriber: string; merchant: string; id: number;
    }>;
  }

  /** With the subscriber's allowance runway (null until the keeper has checked it). */
  listSubscriptions(
    filter: { merchant?: string; subscriber?: string; pendingTransfer?: string } = {}
  ): Array<DbSubscription & { fundsLow: number | null; cyclesCovered: number | null }> {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.merchant) { clauses.push(`s.merchant = ? COLLATE NOCASE`); params.push(filter.merchant); }
    if (filter.subscriber) { clauses.push(`s.subscriber = ? COLLATE NOCASE`); params.push(filter.subscriber); }
    if (filter.pendingTransfer) { clauses.push(`s.pendingTransfer = ? COLLATE NOCASE`); params.push(filter.pendingTransfer); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT s.*, f.low AS fundsLow, f.cycles_covered AS cyclesCovered
         FROM subscriptions s LEFT JOIN subscriber_funds f ON f.subscriber = s.subscriber
         ${where} ORDER BY CAST(s.subId AS INTEGER) ASC`
      )
      .all(...params) as unknown as Array<DbSubscription & { fundsLow: number | null; cyclesCovered: number | null }>;
  }

  // ---- allowance runway (see funds.ts) ----

  /**
   * Chargeable subscriptions with failures on-chain but no dunning row: what a
   * lost or restored database is missing. dueSubscriptions leaves them to the
   * dunning table, so without a row they are never retried.
   */
  subscriptionsMissingDunning(): Array<{ subId: string; failedAttempts: number }> {
    return this.db
      .prepare(
        `SELECT s.subId, s.failedAttempts FROM subscriptions s
         LEFT JOIN dunning d ON d.subId = s.subId
         WHERE s.status IN (${CHARGEABLE.join(",")}) AND s.failedAttempts > 0 AND d.subId IS NULL
         ORDER BY CAST(s.subId AS INTEGER)`
      )
      .all() as Array<{ subId: string; failedAttempts: number }>;
  }

  /** Subscribers with chargeable subscriptions whose funds were never checked or are stale. */
  fundsCandidates(staleBefore: number, limit: number): string[] {
    return (this.db
      .prepare(
        `SELECT DISTINCT s.subscriber FROM subscriptions s
         LEFT JOIN subscriber_funds f ON f.subscriber = s.subscriber
         WHERE s.status IN (${CHARGEABLE.join(",")})
           AND (f.subscriber IS NULL OR f.checked_at <= ?)
         LIMIT ?`
      )
      .all(staleBefore, limit) as Array<{ subscriber: string }>).map((r) => r.subscriber);
  }

  /** With what the runway check needs to price the next charges (see funds.ts). */
  chargeableSubs(subscriber: string): ChargeableSub[] {
    return this.db
      .prepare(
        `SELECT s.subId, s.merchant, s.price, s.nextChargeAt, s.ref, s.introCyclesLeft, s.planCycles,
                COALESCE(p.introPrice, '0') AS introPrice, COALESCE(p.maxCycles, 0) AS maxCycles
         FROM subscriptions s LEFT JOIN plans p ON p.planId = s.planId
         WHERE s.subscriber = ? COLLATE NOCASE AND s.status IN (${CHARGEABLE.join(",")})`
      )
      .all(subscriber) as unknown as ChargeableSub[];
  }

  getFunds(subscriber: string): DbFunds | undefined {
    return this.db
      .prepare(`SELECT * FROM subscriber_funds WHERE subscriber = ?`)
      .get(subscriber) as DbFunds | undefined;
  }

  upsertFunds(f: DbFunds): void {
    this.db
      .prepare(
        `INSERT INTO subscriber_funds
           (subscriber, allowance, balance, per_cycle, cycles_covered, low, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subscriber) DO UPDATE SET
           allowance = excluded.allowance, balance = excluded.balance,
           per_cycle = excluded.per_cycle, cycles_covered = excluded.cycles_covered,
           low = excluded.low, checked_at = excluded.checked_at`
      )
      .run(f.subscriber, f.allowance, f.balance, f.per_cycle, f.cycles_covered, f.low, f.checked_at);
  }

  /** Recheck on the next keeper cycle (after a charge or a new approval). */
  markFundsStale(subscriber: string): void {
    this.db.prepare(`UPDATE subscriber_funds SET checked_at = 0 WHERE subscriber = ?`).run(subscriber);
  }

  /**
   * Plan terms are immutable on-chain; only `retired` changes. The other v2
   * columns are written too, which fills them in on rows from before they existed.
   */
  upsertPlan(p: DbPlan): void {
    this.db
      .prepare(
        `INSERT INTO plans (planId, merchant, price, cycleSeconds, trialSeconds, maxFailed,
                            retired, transferable, maxCycles, introPrice, introCycles)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (planId) DO UPDATE SET
           retired = excluded.retired, transferable = excluded.transferable,
           maxCycles = excluded.maxCycles, introPrice = excluded.introPrice,
           introCycles = excluded.introCycles`
      )
      .run(
        p.planId, p.merchant, p.price, p.cycleSeconds, p.trialSeconds, p.maxFailed,
        p.retired ?? 0, p.transferable ?? 0, p.maxCycles ?? 0, p.introPrice ?? "0", p.introCycles ?? 0
      );
  }

  // ---- merchant accounts ----

  upsertAccount(a: DbAccount): void {
    this.db
      .prepare(
        `INSERT INTO merchant_accounts (account, owner, payout, pendingOwner) VALUES (?, ?, ?, ?)
         ON CONFLICT (account) DO UPDATE SET
           owner = excluded.owner, payout = excluded.payout, pendingOwner = excluded.pendingOwner`
      )
      .run(a.account, a.owner, a.payout, a.pendingOwner);
  }

  getAccount(account: string): DbAccount | undefined {
    return this.db
      .prepare(`SELECT * FROM merchant_accounts WHERE account = ?`)
      .get(account) as DbAccount | undefined;
  }

  /** Who acts for `account`: the account itself until it has handed ownership on. */
  ownerOf(account: string): string {
    return this.getAccount(account)?.owner ?? account;
  }

  /** The accounts `address` acts for: those handed to it, and its own unless it handed that on. */
  accountsOwnedBy(address: string): string[] {
    const handed = (this.db
      .prepare(`SELECT account FROM merchant_accounts WHERE owner = ? COLLATE NOCASE ORDER BY account`)
      .all(address) as Array<{ account: string }>).map((r) => r.account);
    const ownsItself = this.ownerOf(address).toLowerCase() === address.toLowerCase();
    return ownsItself && !handed.some((a) => a.toLowerCase() === address.toLowerCase())
      ? [address, ...handed]
      : handed;
  }

  /** Accounts whose owner has proposed `address` as the next owner. */
  pendingOwnerships(address: string): DbAccount[] {
    return this.db
      .prepare(`SELECT * FROM merchant_accounts WHERE pendingOwner = ? COLLATE NOCASE ORDER BY account`)
      .all(address) as unknown as DbAccount[];
  }

  getPlan(planId: string): DbPlan | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE planId = ?`).get(planId) as unknown as DbPlan | undefined;
  }

  /**
   * The on-chain plan registry mirror: every plan, one merchant account's, or
   * a page of `limit` plans with ids above `after`.
   */
  listPlans(filter: { merchant?: string; after?: number; limit?: number } = {}): DbPlan[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.merchant) { clauses.push(`merchant = ? COLLATE NOCASE`); params.push(filter.merchant); }
    if (filter.after !== undefined) { clauses.push(`CAST(planId AS INTEGER) > ?`); params.push(filter.after); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? `LIMIT ?` : "";
    if (filter.limit !== undefined) params.push(filter.limit);
    return this.db
      .prepare(`SELECT * FROM plans ${where} ORDER BY CAST(planId AS INTEGER) ASC ${limit}`)
      .all(...params) as unknown as DbPlan[];
  }

  chargeStats(merchant?: string): { charges: number; failures: number } {
    const m = merchant ? `AND s.merchant = ? COLLATE NOCASE` : "";
    const params: Array<string | number | null> = merchant ? [merchant] : [];
    const c = this.db
      .prepare(`SELECT COUNT(*) AS n FROM charges c LEFT JOIN subscriptions s ON s.subId = c.subId WHERE 1=1 ${m}`)
      .get(...params) as { n: number };
    const f = this.db
      .prepare(`SELECT COUNT(*) AS n FROM charge_failures f LEFT JOIN subscriptions s ON s.subId = f.subId WHERE 1=1 ${m}`)
      .get(...params) as { n: number };
    return { charges: Number(c.n), failures: Number(f.n) };
  }

  // ---- webhooks ----

  registerWebhook(merchant: string, url: string, events: string[], createdAt: number): number {
    const r = this.db
      .prepare(
        `INSERT INTO webhooks (merchant, url, events, active, created_at)
         VALUES (?, ?, ?, 1, ?)`
      )
      .run(merchant, url, JSON.stringify(events), createdAt);
    return Number(r.lastInsertRowid);
  }

  listWebhooks(merchant?: string): WebhookRow[] {
    const where = merchant ? `WHERE merchant = ? COLLATE NOCASE` : "";
    const params: Array<string | number | null> = merchant ? [merchant] : [];
    return this.db
      .prepare(`SELECT * FROM webhooks ${where} ORDER BY id ASC`)
      .all(...params) as unknown as WebhookRow[];
  }

  getWebhook(id: number): WebhookRow | undefined {
    return this.db
      .prepare(`SELECT * FROM webhooks WHERE id = ?`)
      .get(id) as WebhookRow | undefined;
  }

  deleteWebhook(id: number): void {
    this.db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(id);
  }

  setWebhookActive(id: number, active: boolean): void {
    this.db.prepare(`UPDATE webhooks SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  }

  // ---- webhook deliveries ----

  /**
   * Queue one delivery, and its MAC (WebhookDispatcher) in the same
   * transaction, so a crash never leaves a row the keeper would refuse to
   * send. `eventKey` names the chain event the delivery reports: a log handled
   * twice, as after a crash before the cursor was saved, queues nothing new.
   * Returns the row id, or null when that event is already queued for this
   * webhook.
   */
  enqueueDelivery(
    webhookId: number,
    eventType: string,
    payload: string,
    nowSec: number,
    opts: { eventKey?: string; mac?: (id: number) => string } = {}
  ): number | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db
        .prepare(
          `INSERT INTO webhook_deliveries
             (webhook_id, event_type, payload, status, attempts, next_retry_at, created_at, event_key)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT (webhook_id, event_type, event_key) DO NOTHING`
        )
        .run(webhookId, eventType, payload, nowSec, nowSec, opts.eventKey ?? null);
      const id = r.changes > 0 ? Number(r.lastInsertRowid) : null;
      if (id !== null && opts.mac) {
        this.db.prepare(`UPDATE webhook_deliveries SET mac = ? WHERE id = ?`).run(opts.mac(id), id);
      }
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * One pass worth of due deliveries, fair across webhooks: every webhook's
   * oldest due delivery comes before any webhook's second, no webhook gets more
   * than `perWebhook`, and the pass holds at most `limit`. So one endpoint's
   * backlog can neither starve the others nor make a pass unbounded.
   */
  dueDeliveries(nowSec: number, opts: { limit?: number; perWebhook?: number } = {}): DeliveryRow[] {
    return this.db
      .prepare(
        `SELECT id, webhook_id, event_type, payload, status, attempts,
                next_retry_at, created_at, last_error, mac, event_key
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY webhook_id ORDER BY next_retry_at, id) AS turn
           FROM webhook_deliveries
           WHERE status IN ('pending', 'failed') AND next_retry_at <= ?
         )
         WHERE turn <= ?
         ORDER BY turn, next_retry_at, id
         LIMIT ?`
      )
      .all(nowSec, opts.perWebhook ?? 5, opts.limit ?? 200) as unknown as DeliveryRow[];
  }

  /** `merchant` limits to deliveries of that merchant's (existing) webhooks. */
  listDeliveries(
    filter: { webhookId?: number; status?: string; limit?: number; merchant?: string } = {}
  ): DeliveryRow[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.webhookId !== undefined) { clauses.push(`d.webhook_id = ?`); params.push(filter.webhookId); }
    if (filter.status) { clauses.push(`d.status = ?`); params.push(filter.status); }
    if (filter.merchant) { clauses.push(`w.merchant = ? COLLATE NOCASE`); params.push(filter.merchant); }
    const join = filter.merchant ? `JOIN webhooks w ON w.id = d.webhook_id` : "";
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // Clamped: SQLite treats a negative LIMIT as "no limit".
    const limit = Math.max(1, Math.min(Math.trunc(filter.limit ?? 100) || 100, 500));
    return this.db
      .prepare(`SELECT d.* FROM webhook_deliveries d ${join} ${where} ORDER BY d.id DESC LIMIT ?`)
      .all(...params, limit) as unknown as DeliveryRow[];
  }

  markDeliverySent(id: number): void {
    this.db
      .prepare(`UPDATE webhook_deliveries SET status = 'sent', last_error = NULL WHERE id = ?`)
      .run(id);
  }

  markDeliveryFailed(id: number, nextRetryAt: number, lastError: string): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'failed', attempts = attempts + 1,
             next_retry_at = ?, last_error = ? WHERE id = ?`
      )
      .run(nextRetryAt, lastError, id);
  }

  markDeliveryDead(id: number, lastError: string): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'dead', attempts = attempts + 1, last_error = ? WHERE id = ?`
      )
      .run(lastError, id);
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

  /**
   * Ties the database to one deployment (deploymentId): its plans,
   * subscriptions and event cursor mean nothing for another contract, and
   * serving them would show prices the contract does not charge. A fresh
   * database records the deployment; one recorded for another deployment is
   * refused, and so is one holding data from before the record was kept.
   */
  bindDeployment(id: string): void {
    const stored = this.deployment();
    if (stored === id) return;
    if (stored) {
      throw new Error(`the database belongs to ${stored}, not ${id}: use a fresh database for another deployment`);
    }
    const { n } = this.db
      .prepare(`SELECT (SELECT COUNT(*) FROM plans) + (SELECT COUNT(*) FROM subscriptions)
                     + (SELECT COUNT(*) FROM sync_state WHERE key <> 'delivery_epoch') AS n`)
      .get() as { n: number };
    if (n > 0) {
      throw new Error(
        `the database has data but no record of its deployment, so it cannot be matched to ${id}: ` +
          "start on a fresh database with LEVY_LOOKBACK_BLOCKS reaching back to the deploy"
      );
    }
    this.setSync("deployment", id);
  }

  /** The deployment the keeper recorded (bindDeployment), if any. */
  deployment(): string | undefined {
    return this.getSync("deployment");
  }

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

  /**
   * A random tag fixed when this database first needs one. Delivery ids are
   * `${epoch}-${rowId}`, so a recreated database (row ids from 1 again, same
   * signing key) never repeats an id a receiver has already stored.
   */
  deliveryEpoch(): string {
    this.db
      .prepare(`INSERT OR IGNORE INTO sync_state (key, value) VALUES ('delivery_epoch', ?)`)
      .run(randomBytes(8).toString("hex"));
    return this.getSync("delivery_epoch")!;
  }

  // ---- API auth ----

  createChallenge(nonce: string, address: string, message: string, expiresAt: number, nowSec: number): void {
    this.db.prepare(`DELETE FROM auth_challenges WHERE expires_at <= ?`).run(nowSec);
    this.db
      .prepare(`INSERT INTO auth_challenges (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)`)
      .run(nonce, address, message, expiresAt);
  }

  pendingChallenges(nowSec: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM auth_challenges WHERE expires_at > ?`)
      .get(nowSec) as { n: number };
    return row.n;
  }

  /** Consume a challenge: one statement, so a nonce can never be used twice. */
  takeChallenge(nonce: string, nowSec: number): { address: string; message: string } | undefined {
    return this.db
      .prepare(
        `DELETE FROM auth_challenges WHERE nonce = ? AND expires_at > ?
         RETURNING address, message`
      )
      .get(nonce, nowSec) as { address: string; message: string } | undefined;
  }

  createSession(tokenHash: string, address: string, expiresAt: number, nowSec: number): void {
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowSec);
    this.db
      .prepare(`INSERT INTO sessions (token_hash, address, expires_at) VALUES (?, ?, ?)`)
      .run(tokenHash, address, expiresAt);
  }

  getSession(tokenHash: string, nowSec: number): { address: string; expires_at: number } | undefined {
    return this.db
      .prepare(`SELECT address, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?`)
      .get(tokenHash, nowSec) as { address: string; expires_at: number } | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }
}

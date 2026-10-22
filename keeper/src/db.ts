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
/** States the contract will charge in; PAST_DUE retries are driven by dunning. */
export const CHARGEABLE = [Status.TRIAL, Status.ACTIVE, Status.PAST_DUE];

export function isChargeableStatus(status: number): boolean {
  return (CHARGEABLE as readonly number[]).includes(status);
}

export interface DbPlan {
  planId: string;
  merchant: string;
  price: string; // 6-decimal USDC units
  cycleSeconds: number;
  trialSeconds: number;
  maxFailed: number;
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

export const DELIVERY_STATUSES = ["pending", "sent", "failed", "dead"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

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
}

/** A dunning row with its subscription's context (dashboard queue). */
export type DunningListRow = DunningRow & { subscriber: string; planId: string; price: string; status: number };
/** A charge with the subscription's parties (invoices). */
export type ChargeListRow = DbCharge & { subscriber: string; merchant: string; id: number };

const SCHEMA = `
-- On-chain plan registry mirror, including plans nobody has subscribed to yet.
CREATE TABLE IF NOT EXISTS plans (
  planId TEXT PRIMARY KEY,
  merchant TEXT NOT NULL,
  price TEXT NOT NULL,
  cycleSeconds INTEGER NOT NULL,
  trialSeconds INTEGER NOT NULL,
  maxFailed INTEGER NOT NULL
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
  ref TEXT
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
-- sent on HTTP 2xx, failed while retries remain, and dead (dead-letter) once
-- its next retry would land past 24h of age, so the last attempt is at about
-- 19h21m. "payload" is the exact canonical JSON that is POSTed.
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
-- Hot paths: the due sweep every keeper cycle, webhook fan-out on every event,
-- and the per-merchant / per-subscriber views behind every dashboard and
-- portal load. NOCASE where the queries compare addresses case-insensitively.
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions (status, nextChargeAt);
CREATE INDEX IF NOT EXISTS idx_subscriptions_merchant ON subscriptions (merchant COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions (subscriber COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_charges_sub ON charges (subId);
CREATE INDEX IF NOT EXISTS idx_charge_failures_sub ON charge_failures (subId);
CREATE INDEX IF NOT EXISTS idx_webhooks_merchant ON webhooks (merchant COLLATE NOCASE);
`;

export class LevyDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // The API server may hold the same file open; wait instead of failing
    // on a locked database during brief concurrent writes. Set first, so the
    // schema statements below wait too when both processes start together.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // Databases created before the ref column existed.
    const cols = this.db.prepare(`PRAGMA table_info(subscriptions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "ref")) this.db.exec(`ALTER TABLE subscriptions ADD COLUMN ref TEXT`);
    // WAL: the API's small writes (sign-in, webhook config) never block the
    // keeper's reads, and readers never block writers.
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  // ---- subscriptions ----

  upsertSubscription(s: DbSubscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (subId, subscriber, planId, merchant, price, cycleSeconds, status, nextChargeAt, failedAttempts, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subId) DO UPDATE SET
           planId = excluded.planId, merchant = excluded.merchant,
           price = excluded.price, cycleSeconds = excluded.cycleSeconds,
           status = excluded.status, nextChargeAt = excluded.nextChargeAt,
           failedAttempts = excluded.failedAttempts, ref = excluded.ref`
      )
      .run(
        s.subId, s.subscriber, s.planId, s.merchant, s.price,
        s.cycleSeconds, s.status, s.nextChargeAt, s.failedAttempts, s.ref ?? null
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

  getDunning(subId: string): DunningRow | undefined {
    return this.db
      .prepare(`SELECT * FROM dunning WHERE subId = ?`)
      .get(subId) as DunningRow | undefined;
  }

  /** Dunning queue with subscription context, for the API dashboard. */
  listDunning(merchant?: string): DunningListRow[] {
    const where = merchant ? `WHERE s.merchant = ? COLLATE NOCASE` : "";
    const params: Array<string | number | null> = merchant ? [merchant] : [];
    return this.db
      .prepare(
        `SELECT d.*, s.subscriber, s.planId, s.price, s.status
         FROM dunning d JOIN subscriptions s ON s.subId = d.subId
         ${where} ORDER BY d.nextRetryAt ASC`
      )
      .all(...params) as unknown as DunningListRow[];
  }

  // ---- charges (read side for the API) ----

  listCharges(filter: { subId?: string; merchant?: string } = {}): ChargeListRow[] {
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
      .all(...params) as unknown as ChargeListRow[];
  }

  /** With the subscriber's allowance runway (null until the keeper has checked it). */
  listSubscriptions(
    filter: { merchant?: string; subscriber?: string } = {}
  ): Array<DbSubscription & { fundsLow: number | null; cyclesCovered: number | null }> {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.merchant) { clauses.push(`s.merchant = ? COLLATE NOCASE`); params.push(filter.merchant); }
    if (filter.subscriber) { clauses.push(`s.subscriber = ? COLLATE NOCASE`); params.push(filter.subscriber); }
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

  chargeableSubs(
    subscriber: string
  ): Array<{ subId: string; merchant: string; price: string; nextChargeAt: number; ref: string | null }> {
    return this.db
      .prepare(
        `SELECT subId, merchant, price, nextChargeAt, ref FROM subscriptions
         WHERE subscriber = ? COLLATE NOCASE AND status IN (${CHARGEABLE.join(",")})`
      )
      .all(subscriber) as Array<{ subId: string; merchant: string; price: string; nextChargeAt: number; ref: string | null }>;
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

  /** Plans are immutable on-chain, so an upsert only ever fills a row in. */
  upsertPlan(p: DbPlan): void {
    this.db
      .prepare(
        `INSERT INTO plans (planId, merchant, price, cycleSeconds, trialSeconds, maxFailed)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (planId) DO NOTHING`
      )
      .run(p.planId, p.merchant, p.price, p.cycleSeconds, p.trialSeconds, p.maxFailed);
  }

  /** The on-chain plan registry mirror. */
  listPlans(): DbPlan[] {
    return this.db
      .prepare(`SELECT * FROM plans ORDER BY CAST(planId AS INTEGER) ASC`)
      .all() as unknown as DbPlan[];
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

  enqueueDelivery(webhookId: number, eventType: string, payload: string, nowSec: number): number {
    const r = this.db
      .prepare(
        `INSERT INTO webhook_deliveries
           (webhook_id, event_type, payload, status, attempts, next_retry_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`
      )
      .run(webhookId, eventType, payload, nowSec, nowSec);
    return Number(r.lastInsertRowid);
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
                next_retry_at, created_at, last_error
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

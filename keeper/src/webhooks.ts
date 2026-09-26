import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { LevyDb, type DeliveryRow } from "./db.js";
import { publicOnlyLookup, webhookUrlProblem, type WebhookUrlPolicy } from "./webhook-url.js";

/** The webhook event types merchants can subscribe to. */
export const WEBHOOK_EVENTS = [
  "subscription.created",
  "subscription.updated",
  "charge.succeeded",
  "charge.failed",
  "dunning.started",
  "subscription.paused",
  "subscription.resumed",
  "subscription.cancelled",
  "invoice.ready",
  "allowance.low",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEventType(v: string): v is WebhookEventType {
  return (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Canonical JSON: signatures must be computed over byte-identical payloads.
// JSON.stringify alone is not deterministic across key insertion orders, so we
// recursively sort object keys. Arrays keep their order.
// ---------------------------------------------------------------------------

export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Ed25519 signing key management.
// ---------------------------------------------------------------------------

/**
 * Load the webhook signing key. Precedence:
 *  1. `envKey` (LEVY_WEBHOOK_KEY): PEM PKCS#8, or a base64 32-byte seed.
 *  2. `keyPath` file (LEVY_WEBHOOK_KEY_PATH): loaded if present, otherwise a
 *     fresh keypair is generated and saved with 0600 permissions.
 */
export function loadSigningKey(keyPath: string, envKey?: string): KeyObject {
  if (envKey && envKey.trim()) {
    const v = envKey.trim();
    if (v.includes("BEGIN")) return createPrivateKey(v);
    // Raw 32-byte seed, base64. Wrap in PKCS#8 DER for Ed25519.
    const seed = Buffer.from(v, "base64");
    if (seed.length !== 32) throw new Error("LEVY_WEBHOOK_KEY: expected 32-byte base64 seed or PEM");
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  }
  try {
    return createPrivateKey(readFileSync(keyPath, "utf-8"));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    return privateKey;
  }
}

/** SPKI PEM of the public half, published via GET /api/webhooks/public-key. */
export function publicKeyPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
}

/** Sign canonical payload bytes; returns base64 for the X-Levy-Signature header. */
export function signPayload(privateKey: KeyObject, canonicalBody: string): string {
  return sign(null, Buffer.from(canonicalBody, "utf-8"), privateKey).toString("base64");
}

/** Verify a merchant-side signature. `publicKeyPemStr` is the SPKI PEM from the API. */
export function verifySignature(
  publicKeyPemStr: string,
  canonicalBody: string,
  signatureB64: string
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalBody, "utf-8"),
      createPublicKey(publicKeyPemStr),
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}

/**
 * What a delivery's X-Levy-Signature covers: `${timestamp}.${deliveryId}.${event}.${body}`.
 * Signing the timestamp lets receivers reject replays of a captured delivery;
 * signing the delivery id lets them drop duplicates safely; signing the event
 * type lets them route on X-Levy-Event. None of these headers can be changed
 * without breaking the signature.
 */
export function signedContent(
  timestamp: number | string,
  deliveryId: number | string,
  event: string,
  body: string
): string {
  return `${timestamp}.${deliveryId}.${event}.${body}`;
}

/**
 * Short id of the signing key (first 16 hex chars of SHA-256 over its SPKI
 * DER), sent as X-Levy-Key-Id so the key can be rotated without guesswork.
 */
export function keyId(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return createHash("sha256").update(pub.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
}

export const REPLAY_TOLERANCE_SEC = 300;

/**
 * Receiver-side check of one delivery: the signature matches, and the
 * timestamp is within `toleranceSec` of now. Pass the raw body as received
 * and the X-Levy-Timestamp / X-Levy-Delivery / X-Levy-Event / X-Levy-Signature
 * headers. Receivers should also drop delivery ids they have already processed.
 *
 * Unknown event types are rejected. Event names contain dots, so without that
 * check the same signed bytes could be re-split (delivery id "7.charge", event
 * "succeeded"); no tail or head of a real event name is itself an event name.
 */
export function verifyDelivery(opts: {
  publicKeyPem: string;
  body: string;
  timestamp: string;
  deliveryId: string;
  event: string;
  signature: string;
  nowSec?: number;
  toleranceSec?: number;
}): boolean {
  const ts = Number(opts.timestamp);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (opts.toleranceSec ?? REPLAY_TOLERANCE_SEC)) return false;
  if (!isWebhookEventType(opts.event)) return false;
  return verifySignature(
    opts.publicKeyPem,
    signedContent(opts.timestamp, opts.deliveryId, opts.event, opts.body),
    opts.signature
  );
}

// ---------------------------------------------------------------------------
// Retry schedule: 1m, 5m, 15m, 1h, 6h, then 6h until dead-letter at 24h.
// ---------------------------------------------------------------------------

export const RETRY_DELAYS_SEC = [60, 300, 900, 3600, 21600];
export const DEAD_AFTER_SEC = 24 * 3600;

/**
 * Next retry unix time after `attempts` failures (1-based), or null when the
 * delivery should be dead-lettered (next retry would land past 24h of age).
 */
export function nextRetryAt(attempts: number, nowSec: number, createdAt: number): number | null {
  const delay = RETRY_DELAYS_SEC[Math.min(Math.max(attempts, 1) - 1, RETRY_DELAYS_SEC.length - 1)];
  const next = nowSec + delay;
  return next - createdAt > DEAD_AFTER_SEC ? null : next;
}

// ---------------------------------------------------------------------------
// Contract event -> webhook event mapping (pure, unit-testable).
// ---------------------------------------------------------------------------

export interface WebhookEvent {
  type: WebhookEventType;
  payload: Record<string, unknown>;
}

interface ManagerLogRef {
  transactionHash: string;
  blockNumber: bigint | number;
}

/**
 * Map one SubscriptionManager event to zero or more webhook events.
 * `dunningNextRetryAt` is supplied for ChargeFailed so dunning.started can
 * carry the scheduled retry time.
 */
export function buildWebhookEvents(
  name: string,
  args: Record<string, unknown>,
  log: ManagerLogRef,
  ctx: { merchant: string; ref?: string | null; dunningNextRetryAt?: number }
): WebhookEvent[] {
  if (args.subId === undefined) return [];
  const subId = (args.subId as bigint).toString();
  // Every event carries the merchant's reference, so any of them can be
  // matched to the merchant's own customer record.
  const base = { subId, merchant: ctx.merchant, ref: ctx.ref ?? null };
  const txHash = log.transactionHash;
  const blockNumber = Number(log.blockNumber);
  switch (name) {
    case "Subscribed":
      return [{
        type: "subscription.created",
        payload: {
          ...base,
          subscriber: args.subscriber as string,
          planId: (args.planId as bigint).toString(),
          nextChargeAt: Number(args.nextChargeAt as bigint),
        },
      }];
    case "Charged": {
      const charge = {
        ...base,
        amount: (args.amount as bigint).toString(),
        fee: (args.fee as bigint).toString(),
        invoiceRef: args.invoiceRef as string,
        chargeCount: Number(args.chargeCount as bigint),
        txHash,
        blockNumber,
      };
      return [
        { type: "charge.succeeded", payload: charge },
        { type: "invoice.ready", payload: { ...charge } },
      ];
    }
    case "ChargeFailed": {
      const failedAttempts = Number(args.failedAttempts as bigint);
      const events: WebhookEvent[] = [{
        type: "charge.failed",
        payload: { ...base, failedAttempts, txHash, blockNumber },
      }];
      // First failure opens the dunning schedule.
      if (failedAttempts === 1 && ctx.dunningNextRetryAt !== undefined) {
        events.push({
          type: "dunning.started",
          payload: { ...base, nextRetryAt: ctx.dunningNextRetryAt },
        });
      }
      return events;
    }
    case "Paused":
      return [{ type: "subscription.paused", payload: { ...base, auto: false } }];
    case "AutoPaused":
      return [{ type: "subscription.paused", payload: { ...base, auto: true } }];
    case "Resumed":
      return [{ type: "subscription.resumed", payload: base }];
    case "Cancelled":
      return [{ type: "subscription.cancelled", payload: base }];
    case "PlanChanged":
      // Upgrade or downgrade: the merchant needs to change the customer's
      // tier. The new plan's first cycle arrives as its own charge.succeeded.
      return [{
        type: "subscription.updated",
        payload: {
          ...base,
          oldPlanId: (args.oldPlanId as bigint).toString(),
          newPlanId: (args.newPlanId as bigint).toString(),
          credit: (args.credit as bigint).toString(),
          txHash,
          blockNumber,
        },
      }];
    default:
      return []; // PlanCreated: no webhook event
  }
}

// ---------------------------------------------------------------------------
// Dispatcher: fan-out, signed POST, retries, dead-letter.
// ---------------------------------------------------------------------------

export type WebhookSink = (
  type: WebhookEventType,
  merchant: string,
  payload: Record<string, unknown>,
  atSec: number
) => void;

const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * What a failed delivery records. Raw network errors would tell a caller which
 * ports and hosts answer, so only these categories are stored.
 */
function deliveryError(e: NodeJS.ErrnoException): string {
  if (e.code === "EWEBHOOKBLOCKED") return "refused: resolves to a private or reserved address";
  if (e.code === "ETIMEDOUT") return "timeout after 5s";
  return "connection failed";
}

export class WebhookDispatcher {
  /** allowPrivate: deliver to http and private addresses (local dev and tests only). */
  constructor(
    private db: LevyDb,
    private privateKey: KeyObject,
    private policy: WebhookUrlPolicy = { allowPrivate: false }
  ) {}

  get publicKey(): string {
    return publicKeyPem(this.privateKey);
  }

  register(merchant: string, url: string, events: WebhookEventType[], nowSec: number): number {
    for (const e of events) {
      if (!isWebhookEventType(e)) throw new Error(`unknown event type: ${e}`);
    }
    return this.db.registerWebhook(merchant, url, events, nowSec);
  }

  /** Fan one event out to every active webhook of the merchant subscribed to it. */
  enqueue(
    type: WebhookEventType,
    merchant: string,
    payload: Record<string, unknown>,
    nowSec: number
  ): number[] {
    const ids: number[] = [];
    for (const hook of this.db.listWebhooks(merchant)) {
      if (!hook.active) continue;
      const subscribed: string[] = JSON.parse(hook.events);
      if (!subscribed.includes(type)) continue;
      ids.push(this.db.enqueueDelivery(hook.id, type, canonicalJson(payload), nowSec));
    }
    return ids;
  }

  sink(): WebhookSink {
    return (type, merchant, payload, atSec) => {
      this.enqueue(type, merchant, payload, atSec);
    };
  }

  /**
   * One delivery pass: POST due deliveries, up to `concurrency` at a time.
   * The pass is bounded and fair across webhooks (see LevyDb.dueDeliveries),
   * and each webhook has at most one request in flight, so its deliveries go
   * out in order and a hanging endpoint holds only one slot. Runs in its own
   * loop (index.ts), never inside the charge cycle: a slow endpoint can delay
   * webhooks, not charges. Failures reschedule with backoff.
   */
  async dispatchDue(
    nowSec: number,
    opts: { concurrency?: number; limit?: number; perWebhook?: number } = {}
  ): Promise<{ sent: number; failed: number; dead: number }> {
    const out = { sent: 0, failed: 0, dead: 0 };
    const queue = this.db.dueDeliveries(nowSec, opts);
    const inFlight = new Set<number>();
    const next = () => {
      const i = queue.findIndex((d) => !inFlight.has(d.webhook_id));
      return i < 0 ? undefined : queue.splice(i, 1)[0];
    };
    // A worker that finds only busy webhooks stops; the worker holding that
    // webhook picks up its next delivery when it finishes, so nothing strands.
    const worker = async () => {
      for (let d = next(); d; d = next()) {
        inFlight.add(d.webhook_id);
        try {
          await this.deliver(d, nowSec, out);
        } finally {
          inFlight.delete(d.webhook_id);
        }
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
    return out;
  }

  private async deliver(
    d: DeliveryRow,
    nowSec: number,
    out: { sent: number; failed: number; dead: number }
  ): Promise<void> {
    const hook = this.db.getWebhook(d.webhook_id);
    if (!hook || !hook.active) {
      this.db.markDeliveryDead(d.id, "webhook deleted or deactivated");
      out.dead++;
      return;
    }
    const res = await this.post(hook.url, d);
    if (res.ok) {
      this.db.markDeliverySent(d.id);
      out.sent++;
      return;
    }
    const next = nextRetryAt(d.attempts + 1, nowSec, d.created_at);
    if (next === null) {
      this.db.markDeliveryDead(d.id, res.error);
      out.dead++;
    } else {
      this.db.markDeliveryFailed(d.id, next, res.error);
      out.failed++;
    }
  }

  /**
   * One signed POST. Uses node:http(s) rather than fetch for two reasons: the
   * `lookup` hook refuses private addresses at connect time (see
   * webhook-url.ts), and redirects are never followed (a 3xx is a failure).
   */
  private post(
    url: string,
    d: { id: number; event_type: string; payload: string }
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return Promise.resolve({ ok: false, error: "invalid url" });
    }
    const problem = webhookUrlProblem(u, this.policy);
    if (problem) return Promise.resolve({ ok: false, error: `refused: ${problem}` });

    // Signed at send time, so every retry carries a fresh timestamp.
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(this.privateKey, signedContent(timestamp, d.id, d.event_type, d.payload));
    const body = Buffer.from(d.payload, "utf-8");
    return new Promise((resolve) => {
      const req = (u.protocol === "https:" ? https : http).request(u, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "X-Levy-Signature": signature,
          "X-Levy-Timestamp": String(timestamp),
          "X-Levy-Key-Id": keyId(this.privateKey),
          "X-Levy-Event": d.event_type,
          "X-Levy-Delivery": String(d.id),
        },
        lookup: this.policy.allowPrivate ? undefined : (publicOnlyLookup as any),
      }, (res) => {
        res.destroy(); // the status is all we need; never wait on a trickled body
        clearTimeout(timer);
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300 ? { ok: true } : { ok: false, error: `HTTP ${status}` });
      });
      const timer = setTimeout(
        () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
        DELIVERY_TIMEOUT_MS
      );
      req.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: deliveryError(e) });
      });
      req.end(body);
    });
  }
}

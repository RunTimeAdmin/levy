import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { LevyDb } from "./db.js";

/** The eight webhook event types merchants can subscribe to. */
export const WEBHOOK_EVENTS = [
  "subscription.created",
  "charge.succeeded",
  "charge.failed",
  "dunning.started",
  "subscription.paused",
  "subscription.resumed",
  "subscription.cancelled",
  "invoice.ready",
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
  ctx: { merchant: string; dunningNextRetryAt?: number }
): WebhookEvent[] {
  if (args.subId === undefined) return [];
  const subId = (args.subId as bigint).toString();
  const base = { subId, merchant: ctx.merchant };
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
    default:
      return []; // PlanCreated, PlanChanged: no webhook event
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

const DELIVERY_TIMEOUT_MS = 10_000;

export class WebhookDispatcher {
  constructor(
    private db: LevyDb,
    private privateKey: KeyObject
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

  /** POST every due delivery. Sequential; failures reschedule with backoff. */
  async dispatchDue(nowSec: number): Promise<{ sent: number; failed: number; dead: number }> {
    const out = { sent: 0, failed: 0, dead: 0 };
    for (const d of this.db.dueDeliveries(nowSec)) {
      const hook = this.db.getWebhook(d.webhook_id);
      if (!hook || !hook.active) {
        this.db.markDeliveryDead(d.id, "webhook deleted or deactivated");
        out.dead++;
        continue;
      }
      const res = await this.post(hook.url, d);
      if (res.ok) {
        this.db.markDeliverySent(d.id);
        out.sent++;
      } else {
        const next = nextRetryAt(d.attempts + 1, nowSec, d.created_at);
        if (next === null) {
          this.db.markDeliveryDead(d.id, res.error);
          out.dead++;
        } else {
          this.db.markDeliveryFailed(d.id, next, res.error);
          out.failed++;
        }
      }
    }
    return out;
  }

  private async post(
    url: string,
    d: { id: number; event_type: string; payload: string }
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const signature = signPayload(this.privateKey, d.payload);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Levy-Signature": signature,
          "X-Levy-Event": d.event_type,
          "X-Levy-Delivery": String(d.id),
        },
        body: d.payload,
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true };
      // Drain the body so the socket can be reused.
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e: unknown) {
      const err = e as Error;
      return { ok: false, error: err?.name === "AbortError" ? "timeout after 10s" : (err?.message ?? String(e)) };
    } finally {
      clearTimeout(timer);
    }
  }
}

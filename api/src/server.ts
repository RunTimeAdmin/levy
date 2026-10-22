import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_STATUSES,
  LevyDb,
  Status,
  type DbCharge,
  type DbSubscription,
} from "../../keeper/src/db.js";
import { checkWebhookUrl } from "../../keeper/src/webhook-url.js";
import {
  WEBHOOK_EVENTS,
  isWebhookEventType,
  keyId,
  loadSigningKey,
  publicKeyPem,
} from "../../keeper/src/webhooks.js";
import { fail as bad, registerAuthRoutes } from "./auth.js";

const API_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(API_DIR, "..", "public");

export interface ApiOptions {
  /** Path to the keeper's SQLite file. */
  dbPath: string;
  /** Path of the Ed25519 webhook signing key (for the public-key endpoint). */
  webhookKeyPath: string;
  webhookKey?: string;
  /** Origin the dashboard is served from; sign-in messages are bound to it. */
  origin: string;
  chainId: number;
  /** Allow http and private-address webhook URLs. Local development only. */
  webhookAllowPrivate?: boolean;
  /** Contracts the checkout page talks to (same values the keeper uses). */
  managerAddress?: string;
  usdcAddress?: string;
}

export function apiOptionsFromEnv(): ApiOptions {
  // Sign-in messages name this origin; a wrong default would teach every
  // user to click through the wallet's domain-mismatch warning.
  if (!process.env.LEVY_PUBLIC_ORIGIN && process.env.NODE_ENV === "production") {
    throw new Error("LEVY_PUBLIC_ORIGIN must be set in production (e.g. https://app.getlevy.xyz)");
  }
  return {
    dbPath:
      process.env.LEVY_DB_PATH ?? join(API_DIR, "..", "..", "keeper", "levy.db"),
    webhookKeyPath:
      process.env.LEVY_WEBHOOK_KEY_PATH ??
      join(API_DIR, "..", "..", "keeper", "webhook-signing-key.pem"),
    webhookKey: process.env.LEVY_WEBHOOK_KEY,
    origin: process.env.LEVY_PUBLIC_ORIGIN ?? `http://localhost:${process.env.LEVY_API_PORT ?? 3001}`,
    chainId: Number(process.env.LEVY_CHAIN_ID ?? 5042),
    webhookAllowPrivate: process.env.LEVY_WEBHOOK_ALLOW_PRIVATE === "1",
    managerAddress: process.env.LEVY_MANAGER_ADDRESS,
    usdcAddress: process.env.LEVY_USDC_ADDRESS,
  };
}

const DAY_SECONDS = 86_400;
/** MRR is per 30 days, the length of the "monthly" plan preset. */
const MONTH_SECONDS = 30n * BigInt(DAY_SECONDS);

/** Each webhook costs a delivery per event; keep one merchant from flooding the dispatcher. */
const MAX_WEBHOOKS_PER_MERCHANT = 5;

const STATUS_NAMES: Record<number, string> = {
  [Status.TRIAL]: "trial",
  [Status.ACTIVE]: "active",
  [Status.PAST_DUE]: "past_due",
  [Status.PAUSED]: "paused",
  [Status.CANCELLED]: "cancelled",
};

/** 6-decimal USDC units -> "123.456789". */
export function formatUsdc(amount: string): string {
  const v = BigInt(amount);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** A contract address the pages can use: null when unset, malformed or the zero placeholder. */
function contractAddress(v: unknown): string | null {
  return isAddress(v) && !/^0x0{40}$/.test(v) ? v : null;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A subscription row as the API returns it: the row plus display fields. */
function presentSubscription<T extends DbSubscription>(s: T) {
  return {
    ...s,
    statusName: STATUS_NAMES[s.status] ?? "unknown",
    priceUsdc: formatUsdc(s.price),
    nextChargeAtIso: new Date(s.nextChargeAt * 1000).toISOString(),
  };
}

/** A charge (invoice) row as the API returns it. */
function presentCharge<T extends DbCharge>(c: T) {
  return { ...c, amountUsdc: formatUsdc(c.amount), feeUsdc: formatUsdc(c.fee) };
}

/**
 * An optional address query/body param must name the signed-in address:
 * 400 when malformed, 403 when it is someone else.
 */
function checkOwnAddress(v: unknown, me: string, what: string): void {
  if (v === undefined) return;
  if (!isAddress(v)) bad(400, `invalid ${what} address`);
  if (!sameAddress(v, me)) bad(403, `${what} must be the signed-in address`);
}

export function buildServer(opts: ApiOptions): FastifyInstance {
  const db = new LevyDb(opts.dbPath);
  const app = Fastify({ logger: false });

  app.addHook("onClose", async () => {
    db.close();
  });

  // Every endpoint below except health, plans and the webhook public key
  // needs a session, and only returns the signed-in address's own data: as
  // merchant (dashboard) or as subscriber (portal).
  const requireSession = registerAuthRoutes(app, db, { origin: opts.origin, chainId: opts.chainId });

  // ---- health ----

  app.get("/api/health", async () => ({ ok: true, service: "levy-api", version: "0.1.0" }));

  // What the checkout page needs to build transactions. Public: these are
  // on-chain addresses.
  app.get("/api/config", async () => ({
    chainId: opts.chainId,
    managerAddress: contractAddress(opts.managerAddress),
    usdcAddress: contractAddress(opts.usdcAddress),
  }));

  // ---- plans (read-only mirror of the on-chain plan registry) ----

  app.get("/api/plans", async () => {
    return db.listPlans().map((p) => ({
      ...p,
      priceUsdc: formatUsdc(p.price),
      cycleDays: p.cycleSeconds / DAY_SECONDS,
    }));
  });

  // ---- subscriptions ----

  app.get("/api/subscriptions", async (req) => {
    const me = requireSession(req);
    const q = req.query as { merchant?: string; subscriber?: string; status?: string };
    checkOwnAddress(q.merchant, me, "merchant");
    checkOwnAddress(q.subscriber, me, "subscriber");
    if (q.merchant === undefined && q.subscriber === undefined) {
      return bad(400, "pass merchant or subscriber");
    }
    const filter: { merchant?: string; subscriber?: string } = {};
    if (q.merchant !== undefined) filter.merchant = me;
    if (q.subscriber !== undefined) filter.subscriber = me;
    let subs = db.listSubscriptions(filter);
    if (q.status !== undefined) {
      const n = Number(q.status);
      subs = subs.filter((s) => s.status === n);
    }
    return subs.map(presentSubscription);
  });

  // The signed-in subscriber's allowance runway, as of the keeper's last check.
  app.get("/api/funds", async (req) => {
    const me = requireSession(req);
    const f = db.getFunds(me);
    if (!f) return { checked: false };
    return {
      checked: true,
      allowance: f.allowance,
      allowanceUsdc: formatUsdc(f.allowance),
      balance: f.balance,
      balanceUsdc: formatUsdc(f.balance),
      perCycle: f.per_cycle,
      perCycleUsdc: formatUsdc(f.per_cycle),
      cyclesCovered: f.cycles_covered,
      low: f.low === 1,
    };
  });

  app.get("/api/subscriptions/:id", async (req) => {
    const me = requireSession(req);
    const { id } = req.params as { id: string };
    const sub = db.getSubscription(id);
    // Someone else's subscription looks the same as a missing one.
    if (!sub || !(sameAddress(sub.subscriber, me) || sameAddress(sub.merchant, me))) {
      return bad(404, "subscription not found");
    }
    return {
      ...presentSubscription(sub),
      charges: db.listCharges({ subId: id }).map(presentCharge),
      dunning: db.getDunning(id) ?? null,
    };
  });

  // ---- metrics ----

  app.get("/api/metrics", async (req) => {
    const me = requireSession(req);
    const q = req.query as { merchant?: string };
    checkOwnAddress(q.merchant, me, "merchant");
    const merchant = me;

    const subs = db.listSubscriptions({ merchant });
    const mrrSubs = subs.filter((s) => s.status === Status.TRIAL || s.status === Status.ACTIVE);
    // Normalized to a month: a weekly $10 plan is ~$42.86 of MRR, a yearly
    // $120 plan ~$9.86. Integer math, rounded down per subscription.
    const mrr = mrrSubs
      .reduce((acc, s) => acc + (BigInt(s.price) * MONTH_SECONDS) / BigInt(s.cycleSeconds), 0n)
      .toString();

    const count = (st: number) => subs.filter((s) => s.status === st).length;
    const { charges, failures } = db.chargeStats(merchant);
    const attempts = charges + failures;

    // Totals in raw units across the filtered set.
    const chargeList = db.listCharges({ merchant });
    const totalCharged = chargeList.reduce((acc, c) => acc + BigInt(c.amount), 0n).toString();
    const totalFees = chargeList.reduce((acc, c) => acc + BigInt(c.fee), 0n).toString();

    return {
      merchant,
      mrr,
      mrrUsdc: formatUsdc(mrr),
      totalSubs: subs.length,
      activeSubs: count(Status.ACTIVE),
      trialSubs: count(Status.TRIAL),
      pastDueSubs: count(Status.PAST_DUE),
      pausedSubs: count(Status.PAUSED),
      cancelledSubs: count(Status.CANCELLED),
      totalCharged,
      totalChargedUsdc: formatUsdc(totalCharged),
      totalFees,
      totalFeesUsdc: formatUsdc(totalFees),
      chargeCount: charges,
      failureCount: failures,
      successRate: attempts ? charges / attempts : null,
      dunningDepth: db.listDunning(merchant).length,
    };
  });

  // ---- dunning queue ----

  app.get("/api/dunning", async (req) => {
    const me = requireSession(req);
    const q = req.query as { merchant?: string };
    checkOwnAddress(q.merchant, me, "merchant");
    return db.listDunning(me).map((r) => ({
      ...r,
      priceUsdc: formatUsdc(r.price),
      nextRetryAtIso: new Date(r.nextRetryAt * 1000).toISOString(),
    }));
  });

  // ---- charges / invoices (invoices are charge records) ----

  async function chargesHandler(req: FastifyRequest, reply: FastifyReply) {
    const me = requireSession(req);
    const q = req.query as { subscription?: string; merchant?: string; format?: string };
    checkOwnAddress(q.merchant, me, "merchant");
    const filter: { subId?: string; merchant?: string } = { merchant: me };
    if (q.subscription) filter.subId = q.subscription;
    const rows = db.listCharges(filter);
    if (q.format === "csv") {
      const header = "id,invoiceRef,subId,subscriber,merchant,amountUsdc,feeUsdc,txHash,blockNumber,chargeCount";
      const lines = rows.map((c) =>
        [c.id, c.invoiceRef, c.subId, c.subscriber ?? "", c.merchant ?? "",
         formatUsdc(c.amount), formatUsdc(c.fee), c.txHash, c.blockNumber, c.chargeCount].join(",")
      );
      reply.header("content-type", "text/csv");
      reply.header("content-disposition", 'attachment; filename="levy-invoices.csv"');
      return [header, ...lines].join("\n") + "\n";
    }
    return rows.map(presentCharge);
  }

  app.get("/api/charges", chargesHandler);
  app.get("/api/invoices", chargesHandler);

  // ---- webhooks ----

  app.get("/api/webhooks", async (req) => {
    const me = requireSession(req);
    const q = req.query as { merchant?: string };
    checkOwnAddress(q.merchant, me, "merchant");
    return db.listWebhooks(me).map((w) => ({ ...w, events: JSON.parse(w.events) }));
  });

  app.post("/api/webhooks", async (req) => {
    const me = requireSession(req);
    const body = req.body as { merchant?: string; url?: string; events?: string[] };
    checkOwnAddress(body?.merchant, me, "merchant");
    if (db.listWebhooks(me).length >= MAX_WEBHOOKS_PER_MERCHANT) {
      return bad(400, `webhook limit reached (${MAX_WEBHOOKS_PER_MERCHANT} per merchant)`);
    }
    const url = await checkWebhookUrl(body?.url, { allowPrivate: opts.webhookAllowPrivate ?? false });
    if (!url.ok) return bad(400, url.error);
    if (!Array.isArray(body?.events) || body.events.length === 0) {
      return bad(400, "events must be a non-empty array");
    }
    for (const e of body.events) {
      if (!isWebhookEventType(e)) return bad(400, `unknown event type: ${e}`);
    }
    const id = db.registerWebhook(me, url.url, [...new Set(body.events)], Math.floor(Date.now() / 1000));
    return { id };
  });

  app.delete("/api/webhooks/:id", async (req) => {
    const me = requireSession(req);
    const { id } = req.params as { id: string };
    const n = Number(id);
    if (!Number.isInteger(n)) return bad(400, "invalid id");
    if (!ownWebhook(n, me)) return bad(404, "webhook not found");
    db.deleteWebhook(n);
    return { ok: true };
  });

  app.patch("/api/webhooks/:id", async (req) => {
    const me = requireSession(req);
    const { id } = req.params as { id: string };
    const body = req.body as { active?: boolean };
    const n = Number(id);
    if (!Number.isInteger(n)) return bad(400, "invalid id");
    if (!ownWebhook(n, me)) return bad(404, "webhook not found");
    if (typeof body?.active !== "boolean") return bad(400, "active must be boolean");
    db.setWebhookActive(n, body.active);
    return { ok: true };
  });

  app.get("/api/webhooks/public-key", async () => {
    let key;
    try {
      key = loadSigningKey(opts.webhookKeyPath, opts.webhookKey);
    } catch {
      return bad(503, "signing key not available (keeper has not booted yet)");
    }
    return { algorithm: "ed25519", keyId: keyId(key), publicKey: publicKeyPem(key), events: [...WEBHOOK_EVENTS] };
  });

  app.get("/api/deliveries", async (req) => {
    const me = requireSession(req);
    const q = req.query as { webhookId?: string; status?: string; limit?: string };
    const filter: { webhookId?: number; status?: string; limit?: number; merchant: string } = { merchant: me };
    if (q.webhookId !== undefined) {
      const n = Number(q.webhookId);
      if (!Number.isInteger(n)) return bad(400, "invalid webhookId");
      filter.webhookId = n;
    }
    if (q.status !== undefined) {
      if (!(DELIVERY_STATUSES as readonly string[]).includes(q.status)) return bad(400, "invalid status");
      filter.status = q.status;
    }
    if (q.limit !== undefined) filter.limit = Number(q.limit) || 100;
    return db.listDeliveries(filter);
  });

  /** Someone else's webhook looks the same as a missing one. */
  function ownWebhook(id: number, me: string): boolean {
    const hook = db.getWebhook(id);
    return hook !== undefined && sameAddress(hook.merchant, me);
  }

  // ---- static frontend ----

  app.get("/", async (_req, reply) => sendFile(reply, "index.html"));
  app.get("/portal.html", async (_req, reply) => sendFile(reply, "portal.html"));
  app.get("/checkout.html", async (_req, reply) => sendFile(reply, "checkout.html"));
  app.get<{ Params: { "*": string } }>("/public/*", async (req, reply) => {
    return sendFile(reply, (req.params as { "*": string })["*"]);
  });

  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * Headers for the dashboard, portal and checkout pages. Scripts load only from
 * this origin and never inline, so an injected script cannot run and act with
 * the signed-in session (the session cookie is HttpOnly, so no script can read
 * it). Inline styles stay allowed: an injected style cannot run code.
 * Wallets inject their provider as extension content scripts, which a page's
 * CSP does not govern.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

async function sendFile(reply: FastifyReply, name: string) {
  const safe = normalize(name).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR + sep)) {
    return reply.code(403).send({ error: "forbidden" });
  }
  try {
    const data = await readFile(full);
    const ext = safe.slice(safe.lastIndexOf("."));
    reply.header("content-type", MIME[ext] ?? "application/octet-stream");
    if (ext === ".html") reply.headers(PAGE_HEADERS);
    return reply.send(data);
  } catch {
    return reply.code(404).send({ error: "not found" });
  }
}

// ---- standalone entrypoint ----

async function main(): Promise<void> {
  const app = buildServer(apiOptionsFromEnv());
  const port = Number(process.env.LEVY_API_PORT ?? 3001);
  // Loopback by default; the Docker image sets 0.0.0.0 (container interfaces).
  const host = process.env.LEVY_API_HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  console.log(`levy api listening on http://${host}:${port}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

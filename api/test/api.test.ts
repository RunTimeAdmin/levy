import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { LevyDb } from "../../keeper/src/db.js";
import { buildServer, formatUsdc } from "../src/server.js";
import type { FastifyInstance } from "fastify";

const tmp = mkdtempSync(join(tmpdir(), "levy-api-"));
const DB = join(tmp, "test.db");
const KEY = join(tmp, "wh-key.pem");

const MERCHANT = "0x1111111111111111111111111111111111111111";
const SUBSCRIBER = "0x2222222222222222222222222222222222222222";

let app: FastifyInstance;
let base: string;

function seed(): void {
  const db = new LevyDb(DB);
  db.upsertSubscription({
    subId: "1", subscriber: SUBSCRIBER, planId: "1", merchant: MERCHANT,
    price: "10000000", cycleSeconds: 2592000, status: 1,
    nextChargeAt: 1700000000, failedAttempts: 0,
  });
  db.upsertSubscription({
    subId: "2", subscriber: SUBSCRIBER, planId: "1", merchant: MERCHANT,
    price: "10000000", cycleSeconds: 2592000, status: 2,
    nextChargeAt: 1699900000, failedAttempts: 2,
  });
  db.insertCharge({
    subId: "1", amount: "10000000", fee: "100000", invoiceRef: "inv-aaa",
    txHash: "0xtx1", blockNumber: 10, chargeCount: 1,
  });
  db.insertFailure("2", 1, "0xtx2", 11, 1699900000);
  db.setDunning({ subId: "2", attempts: 1, nextRetryAt: 1699986400, updatedAt: 1699900000 });
  db.close();
}

before(async () => {
  seed();
  // Pre-generate the signing key so the API doesn't create one.
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(KEY, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

  app = buildServer({ dbPath: DB, webhookKeyPath: KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function get(path: string) {
  const r = await fetch(base + path);
  const body = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* csv / html */ }
  return { status: r.status, json, body, headers: r.headers };
}

describe("formatUsdc", () => {
  it("formats 6-decimal units", () => {
    assert.equal(formatUsdc("10000000"), "10.000000");
    assert.equal(formatUsdc("100000"), "0.100000");
    assert.equal(formatUsdc("1"), "0.000001");
    assert.equal(formatUsdc("0"), "0.000000");
  });
});

describe("read endpoints", () => {
  it("GET /api/health", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal((r.json as { ok: boolean }).ok, true);
  });

  it("GET /api/plans", async () => {
    const r = await get("/api/plans");
    assert.equal(r.status, 200);
    const plans = r.json as Array<{ planId: string; priceUsdc: string }>;
    assert.equal(plans.length, 1);
    assert.equal(plans[0].planId, "1");
    assert.equal(plans[0].priceUsdc, "10.000000");
  });

  it("GET /api/subscriptions filters by merchant and subscriber", async () => {
    const r = await get(`/api/subscriptions?merchant=${MERCHANT}`);
    assert.equal(r.status, 200);
    assert.equal((r.json as unknown[]).length, 2);

    const s = await get(`/api/subscriptions?subscriber=${SUBSCRIBER}&status=2`);
    assert.equal((s.json as unknown[]).length, 1);

    const bad = await get("/api/subscriptions?merchant=nope");
    assert.equal(bad.status, 400);
  });

  it("GET /api/subscriptions/:id includes charges and dunning", async () => {
    const r = await get("/api/subscriptions/2");
    assert.equal(r.status, 200);
    const sub = r.json as { statusName: string; dunning: { attempts: number } | null };
    assert.equal(sub.statusName, "past_due");
    assert.equal(sub.dunning?.attempts, 1);

    const missing = await get("/api/subscriptions/999");
    assert.equal(missing.status, 404);
  });

  it("GET /api/metrics computes MRR and success rate", async () => {
    const r = await get(`/api/metrics?merchant=${MERCHANT}`);
    assert.equal(r.status, 200);
    const m = r.json as {
      mrr: string; mrrUsdc: string; activeSubs: number; pastDueSubs: number;
      chargeCount: number; failureCount: number; successRate: number; dunningDepth: number;
      totalChargedUsdc: string;
    };
    // MRR counts trial + active only; sub 2 is past_due.
    assert.equal(m.mrr, "10000000");
    assert.equal(m.mrrUsdc, "10.000000");
    assert.equal(m.activeSubs, 1);
    assert.equal(m.pastDueSubs, 1);
    assert.equal(m.chargeCount, 1);
    assert.equal(m.failureCount, 1);
    assert.equal(m.successRate, 0.5);
    assert.equal(m.dunningDepth, 1);
    assert.equal(m.totalChargedUsdc, "10.000000");
  });

  it("GET /api/dunning returns the queue", async () => {
    const r = await get(`/api/dunning?merchant=${MERCHANT}`);
    assert.equal(r.status, 200);
    const rows = r.json as Array<{ subId: string; nextRetryAtIso: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subId, "2");
    assert.ok(rows[0].nextRetryAtIso.endsWith("Z"));
  });

  it("GET /api/charges returns JSON and CSV", async () => {
    const r = await get(`/api/charges?merchant=${MERCHANT}`);
    assert.equal(r.status, 200);
    const rows = r.json as Array<{ invoiceRef: string; amountUsdc: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].invoiceRef, "inv-aaa");
    assert.equal(rows[0].amountUsdc, "10.000000");

    const csv = await get(`/api/invoices?merchant=${MERCHANT}&format=csv`);
    assert.equal(csv.status, 200);
    assert.ok(csv.headers.get("content-type")?.includes("text/csv"));
    const lines = csv.body.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("id,invoiceRef,subId"));
    assert.ok(lines[1].includes("inv-aaa"));
  });
});

describe("webhook config endpoints", () => {
  it("POST /api/webhooks validates and registers", async () => {
    const ok = await fetch(base + "/api/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant: MERCHANT,
        url: "https://example.com/hook",
        events: ["charge.succeeded", "charge.failed"],
      }),
    });
    assert.equal(ok.status, 200);
    const { id } = (await ok.json()) as { id: number };
    assert.ok(Number.isInteger(id));

    const list = await get(`/api/webhooks?merchant=${MERCHANT}`);
    assert.equal((list.json as unknown[]).length, 1);

    const badEvent = await fetch(base + "/api/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: MERCHANT, url: "https://example.com/h", events: ["bogus"] }),
    });
    assert.equal(badEvent.status, 400);

    const badUrl = await fetch(base + "/api/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: MERCHANT, url: "ftp://example.com/h", events: ["charge.succeeded"] }),
    });
    assert.equal(badUrl.status, 400);

    // Toggle + delete.
    const patch = await fetch(base + `/api/webhooks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(patch.status, 200);
    const del = await fetch(base + `/api/webhooks/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const gone = await fetch(base + `/api/webhooks/${id}`, { method: "DELETE" });
    assert.equal(gone.status, 404);
  });

  it("GET /api/webhooks/public-key serves the SPKI PEM", async () => {
    const r = await get("/api/webhooks/public-key");
    assert.equal(r.status, 200);
    const body = r.json as { algorithm: string; publicKey: string; events: string[] };
    assert.equal(body.algorithm, "ed25519");
    assert.ok(body.publicKey.includes("BEGIN PUBLIC KEY"));
    assert.ok(body.events.includes("charge.succeeded"));
    assert.equal(body.events.length, 8);
  });

  it("GET /api/deliveries is empty when nothing enqueued", async () => {
    const r = await get("/api/deliveries");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  });
});

describe("static frontend", () => {
  it("serves the dashboard and portal", async () => {
    const dash = await get("/");
    assert.equal(dash.status, 200);
    assert.ok(dash.body.includes("Levy") && dash.body.includes("Merchant"));

    const portal = await get("/portal.html");
    assert.equal(portal.status, 200);
    assert.ok(portal.body.includes("My Subscriptions"));
  });
});

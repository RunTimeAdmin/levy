import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LevyDb } from "../src/db.js";
import {
  buildWebhookEvents,
  canonicalJson,
  loadSigningKey,
  nextRetryAt,
  publicKeyPem,
  signPayload,
  verifySignature,
  WebhookDispatcher,
  type WebhookEventType,
} from "../src/webhooks.js";

const tmp = mkdtempSync(join(tmpdir(), "levy-wh-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function testKey() {
  return generateKeyPairSync("ed25519").privateKey;
}

function testDb(): LevyDb {
  return new LevyDb(":memory:");
}

const MERCHANT = "0xmerchant000000000000000000000000000000000001";
const LOG = { transactionHash: "0xtx", blockNumber: 42n };

describe("canonicalJson", () => {
  it("sorts keys recursively and deterministically", () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: [3, 2] } });
    const b = canonicalJson({ a: { c: [3, 2], d: 4 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":[3,2],"d":4},"b":1}');
  });
});

describe("ed25519 signing", () => {
  it("round-trips sign/verify", () => {
    const key = testKey();
    const body = canonicalJson({ subId: "7", amount: "1000" });
    const sig = signPayload(key, body);
    assert.ok(verifySignature(publicKeyPem(key), body, sig));
  });

  it("rejects tampered payloads and wrong keys", () => {
    const key = testKey();
    const body = canonicalJson({ subId: "7" });
    const sig = signPayload(key, body);
    assert.equal(verifySignature(publicKeyPem(key), canonicalJson({ subId: "8" }), sig), false);
    assert.equal(verifySignature(publicKeyPem(testKey()), body, sig), false);
    assert.equal(verifySignature("not-a-pem", body, sig), false);
  });
});

describe("loadSigningKey", () => {
  it("generates and persists a key when missing, loads it on second call", () => {
    const p = join(tmp, "k1.pem");
    const k1 = loadSigningKey(p);
    const k2 = loadSigningKey(p);
    assert.equal(publicKeyPem(k1), publicKeyPem(k2));
  });

  it("accepts a base64 seed from env", () => {
    const seed = randomBytes(32).toString("base64");
    const k1 = loadSigningKey(join(tmp, "unused.pem"), seed);
    const k2 = loadSigningKey(join(tmp, "unused2.pem"), seed);
    assert.equal(publicKeyPem(k1), publicKeyPem(k2));
  });

  it("accepts a PEM from env", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const k = loadSigningKey(join(tmp, "unused3.pem"), pem);
    assert.equal(publicKeyPem(k), publicKeyPem(privateKey));
  });
});

describe("nextRetryAt", () => {
  it("backs off 1m, 5m, 15m, 1h, then 6h", () => {
    assert.equal(nextRetryAt(1, 1000, 1000), 1060);
    assert.equal(nextRetryAt(2, 1000, 1000), 1300);
    assert.equal(nextRetryAt(3, 1000, 1000), 1900);
    assert.equal(nextRetryAt(4, 1000, 1000), 4600);
    assert.equal(nextRetryAt(5, 1000, 1000), 22600);
    assert.equal(nextRetryAt(9, 1000, 1000), 22600); // capped at 6h
  });

  it("dead-letters when the next retry would pass 24h of age", () => {
    assert.equal(nextRetryAt(1, 86_400, 0), null); // already 24h old
    assert.equal(nextRetryAt(6, 80_000, 0), null); // next would be 101600 > 86400
    assert.notEqual(nextRetryAt(5, 60_000, 0), null); // 81600 < 86400, still alive
  });
});

describe("buildWebhookEvents", () => {
  it("maps Subscribed to subscription.created", () => {
    const [e] = buildWebhookEvents(
      "Subscribed",
      { subId: 3n, subscriber: "0xsub", planId: 1n, nextChargeAt: 999n },
      LOG,
      { merchant: MERCHANT }
    );
    assert.equal(e.type, "subscription.created");
    assert.deepEqual(e.payload, {
      subId: "3", merchant: MERCHANT, subscriber: "0xsub", planId: "1", nextChargeAt: 999,
    });
  });

  it("maps Charged to charge.succeeded + invoice.ready", () => {
    const evs = buildWebhookEvents(
      "Charged",
      { subId: 3n, amount: 1000n, fee: 10n, invoiceRef: "inv-1", chargeCount: 2n },
      LOG,
      { merchant: MERCHANT }
    );
    assert.deepEqual(evs.map((e) => e.type), ["charge.succeeded", "invoice.ready"]);
    assert.equal(evs[0].payload.amount, "1000");
    assert.equal(evs[1].payload.invoiceRef, "inv-1");
    assert.equal(evs[1].payload.txHash, "0xtx");
  });

  it("maps ChargeFailed, adding dunning.started only on the first failure", () => {
    const first = buildWebhookEvents(
      "ChargeFailed", { subId: 3n, failedAttempts: 1n }, LOG,
      { merchant: MERCHANT, dunningNextRetryAt: 5555 }
    );
    assert.deepEqual(first.map((e) => e.type), ["charge.failed", "dunning.started"]);
    assert.equal(first[1].payload.nextRetryAt, 5555);

    const second = buildWebhookEvents(
      "ChargeFailed", { subId: 3n, failedAttempts: 2n }, LOG,
      { merchant: MERCHANT, dunningNextRetryAt: 5555 }
    );
    assert.deepEqual(second.map((e) => e.type), ["charge.failed"]);
  });

  it("maps pause/resume/cancel, distinguishing auto-pause", () => {
    const [p] = buildWebhookEvents("Paused", { subId: 1n }, LOG, { merchant: MERCHANT });
    assert.equal(p.type, "subscription.paused");
    assert.equal(p.payload.auto, false);
    const [ap] = buildWebhookEvents("AutoPaused", { subId: 1n }, LOG, { merchant: MERCHANT });
    assert.equal(ap.payload.auto, true);
    const [r] = buildWebhookEvents("Resumed", { subId: 1n }, LOG, { merchant: MERCHANT });
    assert.equal(r.type, "subscription.resumed");
    const [c] = buildWebhookEvents("Cancelled", { subId: 1n }, LOG, { merchant: MERCHANT });
    assert.equal(c.type, "subscription.cancelled");
  });

  it("emits nothing for plan events", () => {
    assert.deepEqual(buildWebhookEvents("PlanCreated", {}, LOG, { merchant: MERCHANT }), []);
    assert.deepEqual(buildWebhookEvents("PlanChanged", { subId: 1n }, LOG, { merchant: MERCHANT }), []);
  });
});

describe("WebhookDispatcher", () => {
  it("fans out only to webhooks subscribed to the event", () => {
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey());
    const a = d.register(MERCHANT, "https://a.example/hook", ["charge.succeeded"], 1000);
    const b = d.register(MERCHANT, "https://b.example/hook", ["charge.failed"], 1000);
    const ids = d.enqueue("charge.succeeded", MERCHANT, { subId: "1" }, 1000);
    assert.equal(ids.length, 1);
    const deliveries = db.listDeliveries();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].webhook_id, a);
    assert.equal(deliveries[0].event_type, "charge.succeeded");
    assert.equal(deliveries[0].status, "pending");
    void b;
    db.close();
  });

  it("skips inactive webhooks", () => {
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey());
    const id = d.register(MERCHANT, "https://a.example/hook", ["charge.succeeded"], 1000);
    db.setWebhookActive(id, false);
    assert.deepEqual(d.enqueue("charge.succeeded", MERCHANT, { subId: "1" }, 1000), []);
    db.close();
  });

  it("rejects unknown event types on register", () => {
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey());
    assert.throws(() => d.register(MERCHANT, "https://a.example/hook", ["nope" as WebhookEventType], 0));
    db.close();
  });
});

describe("dispatchDue (live HTTP)", () => {
  let server: Server;
  let port: number;
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let failMode = false;

  // node:test before() at top level of file would clash; use a local promise.
  const ready = (async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push({ headers: req.headers as Record<string, string>, body });
        if (failMode) { res.statusCode = 500; res.end("boom"); }
        else { res.statusCode = 200; res.end("ok"); }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  })();

  after(() => server?.close());

  it("delivers with verifiable Ed25519 signature headers", async () => {
    await ready;
    received.length = 0;
    const db = testDb();
    const key = testKey();
    const d = new WebhookDispatcher(db, key);
    d.register(MERCHANT, `http://127.0.0.1:${port}/hook`, ["charge.succeeded"], 1000);
    d.enqueue("charge.succeeded", MERCHANT, { subId: "9", amount: "500" }, 1000);

    const out = await d.dispatchDue(1000);
    assert.deepEqual(out, { sent: 1, failed: 0, dead: 0 });
    assert.equal(received.length, 1);
    const [r] = received;
    assert.equal(r.headers["x-levy-event"], "charge.succeeded");
    assert.ok(r.headers["x-levy-delivery"]);
    assert.ok(r.headers["x-levy-signature"]);
    // The posted body must verify against the published public key.
    assert.ok(verifySignature(publicKeyPem(key), r.body, r.headers["x-levy-signature"] as string));
    // And the stored payload must be byte-identical to what was posted.
    const [del] = db.listDeliveries();
    assert.equal(del.status, "sent");
    assert.equal(del.payload, r.body);
    db.close();
  });

  it("retries with backoff on HTTP 500 and dead-letters after 24h", async () => {
    await ready;
    received.length = 0;
    failMode = true;
    try {
      const db = testDb();
      const d = new WebhookDispatcher(db, testKey());
      d.register(MERCHANT, `http://127.0.0.1:${port}/hook`, ["charge.failed"], 0);
      d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);

      // First attempt fails -> scheduled +60s.
      let out = await d.dispatchDue(0);
      assert.deepEqual(out, { sent: 0, failed: 1, dead: 0 });
      let [del] = db.listDeliveries();
      assert.equal(del.status, "failed");
      assert.equal(del.attempts, 1);
      assert.equal(del.next_retry_at, 60);
      assert.equal(del.last_error, "HTTP 500");

      // Not due yet -> untouched.
      out = await d.dispatchDue(30);
      assert.deepEqual(out, { sent: 0, failed: 0, dead: 0 });

      // Due -> fails again, backs off to +300s.
      out = await d.dispatchDue(61);
      assert.deepEqual(out, { sent: 0, failed: 1, dead: 0 });
      [del] = db.listDeliveries();
      assert.equal(del.next_retry_at, 361);

      // Jump past 24h of age -> dead-lettered.
      out = await d.dispatchDue(90_000);
      assert.deepEqual(out, { sent: 0, failed: 0, dead: 1 });
      [del] = db.listDeliveries();
      assert.equal(del.status, "dead");
      db.close();
    } finally {
      failMode = false;
    }
  });

  it("dead-letters deliveries whose webhook was deleted", async () => {
    await ready;
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey());
    const id = d.register(MERCHANT, `http://127.0.0.1:${port}/hook`, ["charge.failed"], 0);
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);
    db.deleteWebhook(id);
    const out = await d.dispatchDue(0);
    assert.deepEqual(out, { sent: 0, failed: 0, dead: 1 });
    db.close();
  });
});

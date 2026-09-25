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
  keyId,
  loadSigningKey,
  nextRetryAt,
  publicKeyPem,
  signPayload,
  verifyDelivery,
  verifySignature,
  WebhookDispatcher,
  type WebhookEventType,
} from "../src/webhooks.js";
import { checkWebhookUrl, isBlockedAddress } from "../src/webhook-url.js";

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
// The live-HTTP tests below deliver to a local server, so they opt in to private addresses.
const LOCAL = { allowPrivate: true };
const STRICT = { allowPrivate: false };

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
  it("maps Subscribed to subscription.created, with the merchant's ref", () => {
    const REF = "0x" + "ab".repeat(32);
    const [e] = buildWebhookEvents(
      "Subscribed",
      { subId: 3n, subscriber: "0xsub", planId: 1n, nextChargeAt: 999n, ref: REF },
      LOG,
      { merchant: MERCHANT, ref: REF }
    );
    assert.equal(e.type, "subscription.created");
    assert.deepEqual(e.payload, {
      subId: "3", merchant: MERCHANT, ref: REF, subscriber: "0xsub", planId: "1", nextChargeAt: 999,
    });
  });

  it("carries the ref on every event, null when the subscription has none", () => {
    const [c] = buildWebhookEvents("Cancelled", { subId: 1n }, LOG, { merchant: MERCHANT, ref: "0xcafe" });
    assert.equal(c.payload.ref, "0xcafe");
    const [p] = buildWebhookEvents("Paused", { subId: 1n }, LOG, { merchant: MERCHANT });
    assert.equal(p.payload.ref, null);
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

  it("maps PlanChanged to subscription.updated, and nothing for PlanCreated", () => {
    assert.deepEqual(buildWebhookEvents("PlanCreated", {}, LOG, { merchant: MERCHANT }), []);
    const ev = buildWebhookEvents(
      "PlanChanged",
      { subId: 1n, oldPlanId: 2n, newPlanId: 3n, credit: 500n },
      LOG,
      { merchant: MERCHANT }
    );
    assert.deepEqual(ev, [{
      type: "subscription.updated",
      payload: {
        subId: "1", merchant: MERCHANT, ref: null, oldPlanId: "2", newPlanId: "3", credit: "500",
        txHash: "0xtx", blockNumber: 42,
      },
    }]);
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

  it("orders a pass fairly across webhooks and caps each webhook", () => {
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey());
    const a = d.register(MERCHANT, "https://a.example/hook", ["charge.failed"], 0);
    const b = d.register("0xother", "https://b.example/hook", ["charge.failed"], 0);
    for (let i = 0; i < 10; i++) d.enqueue("charge.failed", MERCHANT, { n: i }, i); // a's backlog
    d.enqueue("charge.failed", "0xother", { n: "b" }, 50); // b's one, enqueued last
    const turn = db.dueDeliveries(100, { limit: 3 }).map((r) => r.webhook_id);
    assert.deepEqual(turn, [a, b, a]); // b is served before a's second
    const capped = db.dueDeliveries(100, { perWebhook: 2 }).map((r) => r.webhook_id);
    assert.deepEqual(capped, [a, b, a]);
    db.close();
  });
});

describe("dispatchDue (live HTTP)", () => {
  let server: Server;
  let port: number;
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string; path: string }> = [];
  let failMode = false;

  // node:test before() at top level of file would clash; use a local promise.
  const ready = (async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push({ headers: req.headers as Record<string, string>, body, path: req.url ?? "" });
        if (req.url === "/redirect") { res.statusCode = 302; res.setHeader("location", "/hook"); res.end(); }
        else if (req.url === "/trickle") { res.writeHead(200); res.write("never ends"); }
        else if (req.url?.startsWith("/slow")) { setTimeout(() => { res.statusCode = 200; res.end("ok"); }, 400); }
        else if (failMode) { res.statusCode = 500; res.end("boom"); }
        else { res.statusCode = 200; res.end("ok"); }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  })();

  after(() => { server?.closeAllConnections(); server?.close(); });

  it("delivers with verifiable Ed25519 signature headers", async () => {
    await ready;
    received.length = 0;
    const db = testDb();
    const key = testKey();
    const d = new WebhookDispatcher(db, key, LOCAL);
    d.register(MERCHANT, `http://127.0.0.1:${port}/hook`, ["charge.succeeded"], 1000);
    d.enqueue("charge.succeeded", MERCHANT, { subId: "9", amount: "500" }, 1000);

    const out = await d.dispatchDue(1000);
    assert.deepEqual(out, { sent: 1, failed: 0, dead: 0 });
    assert.equal(received.length, 1);
    const [r] = received;
    assert.equal(r.headers["x-levy-event"], "charge.succeeded");
    assert.equal(r.headers["x-levy-key-id"], keyId(key));
    // The delivery must verify against the published public key, and the
    // signature must cover the timestamp and delivery id, not just the body.
    const h = (name: string) => r.headers[name] as string;
    const check = (over: Partial<Parameters<typeof verifyDelivery>[0]> = {}) => verifyDelivery({
      publicKeyPem: publicKeyPem(key), body: r.body, timestamp: h("x-levy-timestamp"),
      deliveryId: h("x-levy-delivery"), signature: h("x-levy-signature"), ...over,
    });
    assert.ok(check());
    assert.ok(Math.abs(Number(h("x-levy-timestamp")) - Date.now() / 1000) < 60);
    assert.equal(check({ deliveryId: "999" }), false, "delivery id is signed");
    assert.equal(check({ body: r.body + " " }), false, "body is signed");
    assert.equal(check({ nowSec: Number(h("x-levy-timestamp")) + 301 }), false, "stale replay rejected");
    assert.equal(check({ publicKeyPem: publicKeyPem(testKey()) }), false, "other key rejected");
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
      const d = new WebhookDispatcher(db, testKey(), LOCAL);
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
    const d = new WebhookDispatcher(db, testKey(), LOCAL);
    const id = d.register(MERCHANT, `http://127.0.0.1:${port}/hook`, ["charge.failed"], 0);
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);
    db.deleteWebhook(id);
    const out = await d.dispatchDue(0);
    assert.deepEqual(out, { sent: 0, failed: 0, dead: 1 });
    db.close();
  });

  it("does not follow redirects", async () => {
    await ready;
    received.length = 0;
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey(), LOCAL);
    d.register(MERCHANT, `http://127.0.0.1:${port}/redirect`, ["charge.failed"], 0);
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);
    const out = await d.dispatchDue(0);
    assert.deepEqual(out, { sent: 0, failed: 1, dead: 0 });
    assert.equal(db.listDeliveries()[0].last_error, "HTTP 302");
    assert.deepEqual(received.map((r) => r.path), ["/redirect"]); // /hook never requested
    db.close();
  });

  it("refuses private addresses at delivery time unless allowed", async () => {
    await ready;
    received.length = 0;
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey(), STRICT);
    // Registered directly, bypassing the API's registration check: the
    // dispatcher must still refuse. http is refused outright; https to a
    // hostname resolving to loopback is refused by the lookup guard, which is
    // what stops DNS rebinding after registration.
    d.register(MERCHANT, `http://127.0.0.1:${port}/hook`, ["charge.failed"], 0);
    d.register(MERCHANT, "https://localhost/hook", ["charge.failed"], 0);
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);
    const out = await d.dispatchDue(0);
    assert.deepEqual(out, { sent: 0, failed: 2, dead: 0 });
    const errors = db.listDeliveries().map((r) => r.last_error ?? "");
    assert.ok(errors.some((e) => e.includes("url must use https")), errors.join(" | "));
    assert.ok(errors.some((e) => e.includes("resolves to a private or reserved address")), errors.join(" | "));
    assert.equal(received.length, 0);
    db.close();
  });

  it("does not wait on a response body that never ends", async () => {
    await ready;
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey(), LOCAL);
    d.register(MERCHANT, `http://127.0.0.1:${port}/trickle`, ["charge.failed"], 0);
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);
    const t0 = Date.now();
    const out = await d.dispatchDue(0);
    assert.deepEqual(out, { sent: 1, failed: 0, dead: 0 });
    assert.ok(Date.now() - t0 < 2000, "should return on the status line");
    db.close();
  });

  it("delivers to different webhooks in parallel", async () => {
    await ready;
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey(), LOCAL);
    for (let i = 0; i < 8; i++) d.register(MERCHANT, `http://127.0.0.1:${port}/slow/${i}`, ["charge.failed"], 0);
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0); // fans out to all 8
    const t0 = Date.now();
    const out = await d.dispatchDue(0);
    assert.deepEqual(out, { sent: 8, failed: 0, dead: 0 });
    // 8 x 400ms one after another would take 3.2s.
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    db.close();
  });

  it("sends one webhook's deliveries one at a time, in order", async () => {
    await ready;
    received.length = 0;
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey(), LOCAL);
    d.register(MERCHANT, `http://127.0.0.1:${port}/slow/ordered`, ["charge.failed"], 0);
    for (let n = 1; n <= 3; n++) d.enqueue("charge.failed", MERCHANT, { n }, n);
    const t0 = Date.now();
    const out = await d.dispatchDue(10);
    assert.deepEqual(out, { sent: 3, failed: 0, dead: 0 });
    assert.ok(Date.now() - t0 >= 1150, "never two at once to the same endpoint");
    assert.deepEqual(received.map((r) => JSON.parse(r.body).n), [1, 2, 3]);
    db.close();
  });

  it("records coarse errors, not raw network messages", async () => {
    const db = testDb();
    const d = new WebhookDispatcher(db, testKey(), LOCAL);
    d.register(MERCHANT, "http://127.0.0.1:1/hook", ["charge.failed"], 0); // nothing listens on port 1
    d.enqueue("charge.failed", MERCHANT, { subId: "1" }, 0);
    await d.dispatchDue(0);
    assert.equal(db.listDeliveries()[0].last_error, "connection failed");
    db.close();
  });
});

describe("webhook URL policy", () => {
  it("classifies addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1",
      "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-ip",
      // Forms that embed IPv4 or are special-purpose (security review, 2026-09-25).
      "::7f00:1", "::ffff:0:7f00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1",
      "2001:0:4136:e378::1", "fec0::1", "2001:db8::1", "192.88.99.1", "::ffff:8.8.8.8",
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it("rejects unsafe URLs at registration", async () => {
    const cases: Array<[string, string]> = [
      ["http://8.8.8.8/hook", "https"],
      ["ftp://8.8.8.8/hook", "https"],
      ["https://user:pw@8.8.8.8/hook", "credentials"],
      ["https://127.0.0.1/hook", "private"],
      ["https://169.254.169.254/latest/meta-data", "private"],
      ["https://[::1]/hook", "private"],
      ["https://[::ffff:10.0.0.1]/hook", "private"],
      ["https://localhost/hook", "private"],
      ["https://no-such-host.invalid/hook", "public address"],
      ["https://8.8.8.8:8443/hook", "443"],
      ["not a url", "valid URL"],
    ];
    for (const [url, why] of cases) {
      const r = await checkWebhookUrl(url, STRICT);
      assert.equal(r.ok, false, url);
      assert.ok(!r.ok && r.error.includes(why), `${url}: ${!r.ok && r.error}`);
    }
  });

  it("accepts public https URLs and normalizes them", async () => {
    const r = await checkWebhookUrl("https://8.8.8.8/hook?x=<y>", STRICT);
    assert.deepEqual(r, { ok: true, url: "https://8.8.8.8/hook?x=%3Cy%3E" });
    const explicitPort = await checkWebhookUrl("https://8.8.8.8:443/hook", STRICT);
    assert.deepEqual(explicitPort, { ok: true, url: "https://8.8.8.8/hook" });
    // Local development can opt in to http and private addresses.
    const local = await checkWebhookUrl("http://127.0.0.1:9/hook", LOCAL);
    assert.equal(local.ok, true);
  });
});

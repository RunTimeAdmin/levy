import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { LevyDb } from "../../keeper/src/db.js";
import { apiOptionsFromEnv, buildServer, formatUsdc } from "../src/server.js";
import type { FastifyInstance } from "fastify";

const tmp = mkdtempSync(join(tmpdir(), "levy-api-"));
const DB = join(tmp, "test.db");
const KEY = join(tmp, "wh-key.pem");
const ORIGIN = "https://app.levy.test";

// Real keys: sign-in needs genuine signatures.
const merchantAcct = privateKeyToAccount(`0x${"11".repeat(32)}`);
const subscriberAcct = privateKeyToAccount(`0x${"22".repeat(32)}`);
const otherAcct = privateKeyToAccount(`0x${"33".repeat(32)}`); // a second merchant
const MERCHANT = merchantAcct.address;
const SUBSCRIBER = subscriberAcct.address;
const OTHER = otherAcct.address;
const MANAGER = "0x14220536ACABfC65543E6129b3d48d2272809CF0";
const USDC = "0x3600000000000000000000000000000000000000";
const REF = `0x${"7f3a".repeat(16)}`;

let app: FastifyInstance;
let base: string;
const tokens: Record<string, string> = {};

function seed(): void {
  const db = new LevyDb(DB);
  db.upsertPlan({ planId: "1", merchant: MERCHANT, price: "10000000", cycleSeconds: 2592000, trialSeconds: 0, maxFailed: 2 });
  db.upsertPlan({ planId: "2", merchant: OTHER, price: "5000000", cycleSeconds: 2592000, trialSeconds: 0, maxFailed: 2 });
  db.upsertPlan({ planId: "3", merchant: OTHER, price: "7000000", cycleSeconds: 604800, trialSeconds: 0, maxFailed: 2 });
  db.upsertSubscription({
    subId: "1", subscriber: SUBSCRIBER, planId: "1", merchant: MERCHANT,
    price: "10000000", cycleSeconds: 2592000, status: 1,
    nextChargeAt: 1700000000, failedAttempts: 0, ref: REF,
  });
  db.upsertSubscription({
    subId: "2", subscriber: SUBSCRIBER, planId: "1", merchant: MERCHANT,
    price: "10000000", cycleSeconds: 2592000, status: 2,
    nextChargeAt: 1699900000, failedAttempts: 2,
  });
  db.upsertSubscription({
    subId: "3", subscriber: SUBSCRIBER, planId: "2", merchant: OTHER,
    price: "5000000", cycleSeconds: 2592000, status: 1,
    nextChargeAt: 1700000000, failedAttempts: 0,
  });
  // Weekly $7 on OTHER: $30 of MRR once normalized to a 30-day month.
  db.upsertSubscription({
    subId: "4", subscriber: SUBSCRIBER, planId: "3", merchant: OTHER,
    price: "7000000", cycleSeconds: 604800, status: 1,
    nextChargeAt: 1700000000, failedAttempts: 0,
  });
  db.insertCharge({
    subId: "1", amount: "10000000", fee: "100000", invoiceRef: "inv-aaa",
    txHash: "0xtx1", blockNumber: 10, chargeCount: 1,
  });
  db.insertCharge({
    subId: "3", amount: "5000000", fee: "50000", invoiceRef: "inv-other",
    txHash: "0xtx3", blockNumber: 12, chargeCount: 1,
  });
  db.insertFailure("2", 1, "0xtx2", 11, 1699900000);
  db.setDunning({ subId: "2", attempts: 1, nextRetryAt: 1699986400, updatedAt: 1699900000 });
  // The subscriber's allowance covers one more round of their charges: low.
  db.upsertFunds({
    subscriber: SUBSCRIBER, allowance: "32000000", balance: "5000000", per_cycle: "32000000",
    cycles_covered: 1, low: 1, checked_at: 1700000000,
  });
  db.close();
}

before(async () => {
  seed();
  // Pre-generate the signing key so the API doesn't create one.
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(KEY, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

  app = buildServer({
    dbPath: DB, webhookKeyPath: KEY, origin: ORIGIN, chainId: 5042002,
    managerAddress: MANAGER, usdcAddress: USDC,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;

  for (const acct of [merchantAcct, subscriberAcct, otherAcct]) {
    tokens[acct.address] = await signIn(acct);
  }
});

after(async () => {
  await app?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { as?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  const token = opts.token ?? (opts.as ? tokens[opts.as] : undefined);
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv / html */ }
  return { status: r.status, json, body: text, headers: r.headers };
}

const get = (path: string, as?: string) => call("GET", path, { as });

async function challenge(address: string) {
  const r = await call("POST", "/api/auth/challenge", { body: { address } });
  assert.equal(r.status, 200);
  return r.json as { nonce: string; message: string };
}

async function signIn(acct: PrivateKeyAccount): Promise<string> {
  const { nonce, message } = await challenge(acct.address);
  const signature = await acct.signMessage({ message });
  const r = await call("POST", "/api/auth/verify", { body: { nonce, signature } });
  assert.equal(r.status, 200, r.body);
  return r.json.token;
}

describe("formatUsdc", () => {
  it("formats 6-decimal units", () => {
    assert.equal(formatUsdc("10000000"), "10.000000");
    assert.equal(formatUsdc("100000"), "0.100000");
    assert.equal(formatUsdc("1"), "0.000001");
    assert.equal(formatUsdc("0"), "0.000000");
  });
});

describe("sign-in", () => {
  it("issues an EIP-4361 message bound to the configured origin and chain", async () => {
    const { nonce, message } = await challenge(MERCHANT.toLowerCase());
    const parsed = parseSiweMessage(message);
    assert.equal(parsed.domain, "app.levy.test");
    assert.equal(parsed.uri, ORIGIN);
    assert.equal(parsed.address, MERCHANT); // checksummed
    assert.equal(parsed.chainId, 5042002);
    assert.equal(parsed.nonce, nonce);
    assert.ok(parsed.expirationTime && parsed.expirationTime > new Date());
  });

  it("signs in, reports the session, and logs out", async () => {
    const token = await signIn(merchantAcct);
    const s = await call("GET", "/api/auth/session", { token });
    assert.equal(s.status, 200);
    assert.equal(s.json.address, MERCHANT);

    assert.equal((await call("POST", "/api/auth/logout", { token })).status, 200);
    assert.equal((await call("GET", "/api/auth/session", { token })).status, 401);
  });

  it("rejects a reused nonce", async () => {
    const { nonce, message } = await challenge(MERCHANT);
    const signature = await merchantAcct.signMessage({ message });
    assert.equal((await call("POST", "/api/auth/verify", { body: { nonce, signature } })).status, 200);
    assert.equal((await call("POST", "/api/auth/verify", { body: { nonce, signature } })).status, 401);
  });

  it("rejects a signature from a different wallet", async () => {
    const { nonce, message } = await challenge(MERCHANT);
    const signature = await otherAcct.signMessage({ message });
    const r = await call("POST", "/api/auth/verify", { body: { nonce, signature } });
    assert.equal(r.status, 401);
    // The failed attempt burns the challenge.
    const retry = await call("POST", "/api/auth/verify", {
      body: { nonce, signature: await merchantAcct.signMessage({ message }) },
    });
    assert.equal(retry.status, 401);
  });

  it("rejects unknown nonces and malformed input", async () => {
    const sig = await merchantAcct.signMessage({ message: "anything" });
    assert.equal((await call("POST", "/api/auth/verify", { body: { nonce: "nope", signature: sig } })).status, 401);
    assert.equal((await call("POST", "/api/auth/verify", { body: { nonce: "x", signature: "zz" } })).status, 400);
    assert.equal((await call("POST", "/api/auth/challenge", { body: { address: "nope" } })).status, 400);
  });

  it("requires a valid session on every private endpoint", async () => {
    const paths = [
      ["GET", `/api/subscriptions?merchant=${MERCHANT}`], ["GET", "/api/subscriptions/1"],
      ["GET", "/api/metrics"], ["GET", "/api/dunning"], ["GET", "/api/charges"], ["GET", "/api/funds"],
      ["GET", "/api/invoices?format=csv"], ["GET", "/api/webhooks"], ["GET", "/api/deliveries"],
      ["POST", "/api/webhooks"], ["PATCH", "/api/webhooks/1"], ["DELETE", "/api/webhooks/1"],
    ] as const;
    for (const [method, path] of paths) {
      assert.equal((await call(method, path)).status, 401, `${method} ${path} without token`);
      assert.equal((await call(method, path, { token: "garbage" })).status, 401, `${method} ${path} bad token`);
    }
  });
});

describe("cookie sessions (the pages)", () => {
  // What auth.js does: verify with cookie: true, then rely on the cookie.
  async function cookieSignIn(acct: PrivateKeyAccount, url = base) {
    const post = (path: string, body: unknown) => fetch(url + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const { nonce, message } = await (await post("/api/auth/challenge", { address: acct.address })).json();
    const signature = await acct.signMessage({ message });
    const r = await post("/api/auth/verify", { nonce, signature, cookie: true });
    assert.equal(r.status, 200);
    return { json: await r.json(), setCookie: r.headers.get("set-cookie") ?? "" };
  }
  function withCookie(cookie: string, method: string, path: string, extra: Record<string, string> = {}, body?: unknown) {
    const headers: Record<string, string> = { cookie: cookie.split(";")[0], ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  it("sets an HttpOnly, Secure, SameSite=Strict __Host- cookie and returns no token", async () => {
    const { json, setCookie } = await cookieSignIn(merchantAcct);
    assert.equal(json.address, MERCHANT);
    assert.equal(json.token, undefined);
    assert.match(setCookie, /^__Host-levy_session=[\w-]{43}; /);
    const attrs = setCookie.split("; ");
    for (const attr of ["Path=/", "Max-Age=86400", "HttpOnly", "SameSite=Strict", "Secure"]) {
      assert.ok(attrs.includes(attr), `${attr} missing: ${setCookie}`);
    }
    assert.ok(!/domain=/i.test(setCookie), "a Domain attribute would share it with sibling hosts");
  });

  it("authenticates reads with the cookie alone, and only under its own name", async () => {
    const { setCookie } = await cookieSignIn(merchantAcct);
    const s = await withCookie(setCookie, "GET", "/api/auth/session");
    assert.equal(s.status, 200);
    assert.equal((await s.json()).address, MERCHANT);
    assert.equal((await withCookie(setCookie, "GET", `/api/subscriptions?merchant=${MERCHANT}`)).status, 200);
    // A cookie a sibling host could set (no __Host- prefix) is ignored.
    const token = setCookie.split(";")[0].split("=")[1];
    assert.equal((await withCookie(`levy_session=${token}`, "GET", "/api/auth/session")).status, 401);
    // An Authorization header wins over the cookie, even a bad one.
    assert.equal((await withCookie(setCookie, "GET", "/api/auth/session", { authorization: "Bearer garbage" })).status, 401);
  });

  it("refuses cookie-authenticated writes that do not come from this origin", async () => {
    const { setCookie } = await cookieSignIn(merchantAcct);
    for (const origin of [undefined, "https://getlevy.xyz", "null"]) {
      const extra: Record<string, string> = origin === undefined ? {} : { origin };
      const patch = await withCookie(setCookie, "PATCH", "/api/webhooks/999999", extra, { active: false });
      assert.equal(patch.status, 403, `PATCH from ${origin}`);
      assert.equal((await withCookie(setCookie, "POST", "/api/auth/logout", extra)).status, 403, `logout from ${origin}`);
    }
    // The session survived the refused logouts, and the app's own origin gets through
    // to the handler (404: there is no such webhook).
    assert.equal((await withCookie(setCookie, "GET", "/api/auth/session")).status, 200);
    const own = await withCookie(setCookie, "PATCH", "/api/webhooks/999999", { origin: ORIGIN }, { active: false });
    assert.equal(own.status, 404);
  });

  it("logs out: revokes the session and clears the cookie", async () => {
    const { setCookie } = await cookieSignIn(merchantAcct);
    const r = await withCookie(setCookie, "POST", "/api/auth/logout", { origin: ORIGIN });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie") ?? "", /^__Host-levy_session=; Path=\/; Max-Age=0; HttpOnly/);
    assert.equal((await withCookie(setCookie, "GET", "/api/auth/session")).status, 401);
  });

  it("drops the __Host- prefix and Secure on a local http origin", async () => {
    const local = buildServer({ dbPath: DB, webhookKeyPath: KEY, origin: "http://localhost:3001", chainId: 5042002 });
    await local.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = local.server.address() as { port: number };
      const { setCookie } = await cookieSignIn(merchantAcct, `http://127.0.0.1:${addr.port}`);
      assert.match(setCookie, /^levy_session=[\w-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Strict$/);
    } finally {
      await local.close();
    }
  });
});

describe("public endpoints", () => {
  it("GET /api/health", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });

  it("GET /api/config gives the checkout page its chain and contracts", async () => {
    const r = await get("/api/config");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { chainId: 5042002, managerAddress: MANAGER, usdcAddress: USDC });
  });

  it("GET /api/plans", async () => {
    const r = await get("/api/plans");
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 3);
    assert.equal(r.json[0].planId, "1");
    assert.equal(r.json[0].priceUsdc, "10.000000");
  });

  it("GET /api/webhooks/public-key serves the SPKI PEM", async () => {
    const r = await get("/api/webhooks/public-key");
    assert.equal(r.status, 200);
    assert.equal(r.json.algorithm, "ed25519");
    assert.match(r.json.keyId, /^[0-9a-f]{16}$/);
    assert.ok(r.json.publicKey.includes("BEGIN PUBLIC KEY"));
    assert.equal(r.json.events.length, 10);
    assert.ok(r.json.events.includes("allowance.low"));
    assert.ok(r.json.events.includes("subscription.updated"));
  });
});

describe("data is scoped to the signed-in address", () => {
  it("subscriptions: own merchant or subscriber view only", async () => {
    const r = await get(`/api/subscriptions?merchant=${MERCHANT}`, MERCHANT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((s: any) => s.subId), ["1", "2"]);
    assert.deepEqual(r.json.map((s: any) => s.ref), [REF, null]); // the merchant's own reference

    const s = await get(`/api/subscriptions?subscriber=${SUBSCRIBER}&status=2`, SUBSCRIBER);
    assert.deepEqual(s.json.map((x: any) => x.subId), ["2"]);

    assert.equal((await get(`/api/subscriptions?merchant=${OTHER}`, MERCHANT)).status, 403);
    assert.equal((await get(`/api/subscriptions?subscriber=${SUBSCRIBER}`, MERCHANT)).status, 403);
    assert.equal((await get("/api/subscriptions?merchant=nope", MERCHANT)).status, 400);
    assert.equal((await get("/api/subscriptions", MERCHANT)).status, 400);
  });

  it("funds: the signed-in subscriber's allowance runway, and the flag on merchant views", async () => {
    const f = await get("/api/funds", SUBSCRIBER);
    assert.equal(f.status, 200);
    assert.equal(f.json.low, true);
    assert.equal(f.json.cyclesCovered, 1);
    assert.equal(f.json.allowanceUsdc, "32.000000");
    assert.equal(f.json.balanceUsdc, "5.000000");
    assert.deepEqual((await get("/api/funds", MERCHANT)).json, { checked: false });

    const subs = await get(`/api/subscriptions?merchant=${MERCHANT}`, MERCHANT);
    assert.ok(subs.json.every((s: any) => s.fundsLow === 1 && s.cyclesCovered === 1));
  });

  it("subscription detail: visible to its subscriber and merchant, 404 to anyone else", async () => {
    const r = await get("/api/subscriptions/2", SUBSCRIBER);
    assert.equal(r.status, 200);
    assert.equal(r.json.statusName, "past_due");
    assert.equal(r.json.dunning?.attempts, 1);

    assert.equal((await get("/api/subscriptions/2", MERCHANT)).status, 200);
    assert.equal((await get("/api/subscriptions/2", OTHER)).status, 404);
    assert.equal((await get("/api/subscriptions/999", MERCHANT)).status, 404);
  });

  it("metrics are computed for the signed-in merchant", async () => {
    const r = await get("/api/metrics", MERCHANT);
    assert.equal(r.status, 200);
    const m = r.json;
    assert.equal(m.merchant, MERCHANT);
    // MRR counts trial + active only; sub 2 is past_due.
    assert.equal(m.mrr, "10000000");
    assert.equal(m.activeSubs, 1);
    assert.equal(m.pastDueSubs, 1);
    assert.equal(m.chargeCount, 1);
    assert.equal(m.failureCount, 1);
    assert.equal(m.successRate, 0.5);
    assert.equal(m.dunningDepth, 1);
    assert.equal(m.totalChargedUsdc, "10.000000");

    const other = await get("/api/metrics", OTHER);
    assert.equal(other.json.totalSubs, 2);
    // $5 monthly + $7 weekly (x 30/7 = $30) per 30-day month.
    assert.equal(other.json.mrrUsdc, "35.000000");
    assert.equal(other.json.totalChargedUsdc, "5.000000");
    assert.equal((await get(`/api/metrics?merchant=${MERCHANT}`, OTHER)).status, 403);
  });

  it("dunning queue", async () => {
    const r = await get("/api/dunning", MERCHANT);
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].subId, "2");
    assert.ok(r.json[0].nextRetryAtIso.endsWith("Z"));
    assert.equal((await get("/api/dunning", OTHER)).json.length, 0);
  });

  it("charges and CSV invoices", async () => {
    const r = await get("/api/charges", MERCHANT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((c: any) => c.invoiceRef), ["inv-aaa"]);
    assert.equal(r.json[0].amountUsdc, "10.000000");

    const csv = await get("/api/invoices?format=csv", MERCHANT);
    assert.equal(csv.status, 200);
    assert.ok(csv.headers.get("content-type")?.includes("text/csv"));
    const lines = csv.body.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("id,invoiceRef,subId"));
    assert.ok(lines[1].includes("inv-aaa"));

    // Another merchant's subscription id does not leak its charges.
    assert.deepEqual((await get("/api/charges?subscription=3", MERCHANT)).json, []);
  });
});

describe("webhooks", () => {
  // IP-literal URLs keep these tests off the network (no DNS).
  const HOOK = "https://8.8.8.8/hook";

  it("registers, lists, toggles and deletes for the signed-in merchant only", async () => {
    const ok = await call("POST", "/api/webhooks", {
      as: MERCHANT, body: { url: HOOK, events: ["charge.succeeded", "charge.failed"] },
    });
    assert.equal(ok.status, 200, ok.body);
    const id = ok.json.id as number;

    const mine = await get("/api/webhooks", MERCHANT);
    assert.equal(mine.json.length, 1);
    assert.equal(mine.json[0].merchant, MERCHANT);
    assert.equal((await get("/api/webhooks", OTHER)).json.length, 0);

    // Another merchant cannot see, toggle or delete it.
    assert.equal((await call("PATCH", `/api/webhooks/${id}`, { as: OTHER, body: { active: false } })).status, 404);
    assert.equal((await call("DELETE", `/api/webhooks/${id}`, { as: OTHER })).status, 404);

    assert.equal((await call("PATCH", `/api/webhooks/${id}`, { as: MERCHANT, body: { active: false } })).status, 200);
    assert.equal((await call("DELETE", `/api/webhooks/${id}`, { as: MERCHANT })).status, 200);
    assert.equal((await call("DELETE", `/api/webhooks/${id}`, { as: MERCHANT })).status, 404);
  });

  it("cannot register for another merchant", async () => {
    const r = await call("POST", "/api/webhooks", {
      as: MERCHANT, body: { merchant: OTHER, url: HOOK, events: ["charge.succeeded"] },
    });
    assert.equal(r.status, 403);
  });

  it("rejects unknown events and unsafe URLs", async () => {
    const post = (url: string, events = ["charge.succeeded"]) =>
      call("POST", "/api/webhooks", { as: MERCHANT, body: { url, events } });
    assert.equal((await post(HOOK, ["bogus"])).status, 400);
    for (const [url, why] of [
      ["http://8.8.8.8/hook", "https"],
      ["ftp://8.8.8.8/hook", "https"],
      ["https://user:pw@8.8.8.8/hook", "credentials"],
      ["https://127.0.0.1/hook", "private"],
      ["https://169.254.169.254/latest/meta-data", "private"],
      ["https://[::1]/hook", "private"],
      ["https://localhost/hook", "private"],
      ["https://8.8.8.8:8080/hook", "443"],
    ]) {
      const r = await post(url);
      assert.equal(r.status, 400, url);
      assert.ok(r.body.includes(why), `${url}: ${r.body}`);
    }
  });

  it("deliveries: only the signed-in merchant's", async () => {
    const db = new LevyDb(DB);
    const mine = db.registerWebhook(MERCHANT, HOOK, ["charge.succeeded"], 0);
    const theirs = db.registerWebhook(OTHER, HOOK, ["charge.succeeded"], 0);
    db.enqueueDelivery(mine, "charge.succeeded", "{\"subId\":\"1\"}", 0);
    db.enqueueDelivery(theirs, "charge.succeeded", "{\"subId\":\"3\"}", 0);
    db.close();

    const r = await get("/api/deliveries", MERCHANT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((d: any) => d.webhook_id), [mine]);
    // Asking for another merchant's webhook id returns nothing.
    assert.deepEqual((await get(`/api/deliveries?webhookId=${theirs}`, MERCHANT)).json, []);
    // limit is clamped (SQLite reads a negative LIMIT as "no limit").
    assert.equal((await get("/api/deliveries?limit=-1", MERCHANT)).json.length, 1);
    assert.equal((await get("/api/deliveries?limit=1.5", MERCHANT)).status, 200);
  });

  it("caps webhooks per merchant", async () => {
    // The subscriber wallet acts as a fresh merchant here.
    for (let i = 0; i < 5; i++) {
      const r = await call("POST", "/api/webhooks", {
        as: SUBSCRIBER, body: { url: `https://8.8.8.8/hook${i}`, events: ["charge.succeeded"] },
      });
      assert.equal(r.status, 200, r.body);
    }
    const sixth = await call("POST", "/api/webhooks", {
      as: SUBSCRIBER, body: { url: "https://8.8.8.8/hook6", events: ["charge.succeeded"] },
    });
    assert.equal(sixth.status, 400);
    assert.ok(sixth.body.includes("limit"));
  });
});

describe("configuration", () => {
  it("refuses to start in production without LEVY_PUBLIC_ORIGIN", () => {
    const saved = { origin: process.env.LEVY_PUBLIC_ORIGIN, env: process.env.NODE_ENV };
    try {
      delete process.env.LEVY_PUBLIC_ORIGIN;
      process.env.NODE_ENV = "production";
      assert.throws(() => apiOptionsFromEnv(), /LEVY_PUBLIC_ORIGIN/);
      process.env.LEVY_PUBLIC_ORIGIN = "https://app.levy.test";
      assert.equal(apiOptionsFromEnv().origin, "https://app.levy.test");
    } finally {
      if (saved.origin === undefined) delete process.env.LEVY_PUBLIC_ORIGIN;
      else process.env.LEVY_PUBLIC_ORIGIN = saved.origin;
      if (saved.env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.env;
    }
  });
});

describe("static frontend", () => {
  it("serves the dashboard, portal and sign-in script", async () => {
    const dash = await get("/");
    assert.equal(dash.status, 200);
    assert.ok(dash.body.includes("Levy") && dash.body.includes("Merchant"));

    const portal = await get("/portal.html");
    assert.equal(portal.status, 200);
    assert.ok(portal.body.includes("My Subscriptions"));

    const auth = await get("/public/auth.js");
    assert.equal(auth.status, 200);
    assert.ok(auth.headers.get("content-type")?.includes("javascript"));

    const checkout = await get("/checkout.html");
    assert.equal(checkout.status, 200);
    assert.ok(checkout.body.includes("Levy Checkout"));
    assert.equal((await get("/public/wallet.js")).status, 200);
  });

  it("sends a CSP on every page that forbids inline scripts, and the pages have none", async () => {
    for (const [path, script] of [["/", "dashboard.js"], ["/portal.html", "portal.js"], ["/checkout.html", "checkout.js"]]) {
      const page = await get(path);
      const csp = page.headers.get("content-security-policy") ?? "";
      assert.ok(csp.includes("script-src 'self'"), `${path}: CSP ${csp}`);
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `${path}: inline scripts allowed`);
      assert.ok(csp.includes("frame-ancestors 'none'"), path);
      assert.equal(page.headers.get("x-frame-options"), "DENY", path);
      // Every <script> loads from a file; an inline one would be blocked by the CSP.
      const tags = page.body.match(/<script[^>]*>/g) ?? [];
      assert.ok(tags.length > 0 && tags.every((t) => /\ssrc="\/public\/[a-z-]+\.js"/.test(t)), `${path}: ${tags}`);
      assert.ok(page.body.includes(`/public/${script}`), path);
      assert.equal((await get(`/public/${script}`)).status, 200, script);
    }
  });

  it("does not send the page CSP on API responses", async () => {
    const health = await get("/api/health");
    assert.equal(health.headers.get("content-security-policy"), null);
  });
});

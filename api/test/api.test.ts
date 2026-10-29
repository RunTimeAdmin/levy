import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import dns from "node:dns";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { LevyDb, deploymentId } from "../../keeper/src/db.js";
import { writePublicKey } from "../../keeper/src/webhooks.js";
import { apiOptionsFromEnv, buildServer, formatUsdc, publicOrigin } from "../src/server.js";
import type { FastifyInstance } from "fastify";

const tmp = mkdtempSync(join(tmpdir(), "levy-api-"));
const DB = join(tmp, "test.db");
const PUBKEY = join(tmp, "wh-public-key.pem");
const ORIGIN = "https://app.levy.test";

// Real keys: sign-in needs genuine signatures.
const merchantAcct = privateKeyToAccount(`0x${"11".repeat(32)}`);
const subscriberAcct = privateKeyToAccount(`0x${"22".repeat(32)}`);
const otherAcct = privateKeyToAccount(`0x${"33".repeat(32)}`); // a second merchant
// A merchant that handed its account to OTHER, and offered it on to MERCHANT (v2).
const formerAcct = privateKeyToAccount(`0x${"44".repeat(32)}`);
const MERCHANT = merchantAcct.address;
const SUBSCRIBER = subscriberAcct.address;
const OTHER = otherAcct.address;
const FORMER = formerAcct.address;
const SAFE = "0x5afE5afe5afE5AFE5aFe5aFE5Afe5aFe5afe5AFE";
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
  // v2: FORMER's account, now owned by OTHER, with a fixed payout and MERCHANT as the proposed next owner.
  db.upsertPlan({
    planId: "4", merchant: FORMER, price: "20000000", cycleSeconds: 2592000, trialSeconds: 0, maxFailed: 2,
    retired: 1, transferable: 1, maxCycles: 2, introPrice: "1000000", introCycles: 1,
  });
  db.upsertAccount({ account: FORMER, owner: OTHER, payout: SAFE, pendingOwner: MERCHANT });
  db.upsertSubscription({
    subId: "5", subscriber: SUBSCRIBER, planId: "4", merchant: FORMER,
    price: "20000000", cycleSeconds: 2592000, status: 5,
    nextChargeAt: 1700000000, failedAttempts: 0, planCycles: 2,
  });
  // Offered by SUBSCRIBER to MERCHANT's wallet, awaiting acceptTransfer.
  db.upsertSubscription({
    subId: "6", subscriber: SUBSCRIBER, planId: "4", merchant: FORMER,
    price: "20000000", cycleSeconds: 2592000, status: 1,
    nextChargeAt: 1700000000, failedAttempts: 0, planCycles: 1, pendingTransfer: MERCHANT,
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
  // The keeper publishes the public key; the API only reads it.
  const { privateKey } = generateKeyPairSync("ed25519");
  writePublicKey(PUBKEY, privateKey);

  app = buildServer({
    dbPath: DB, webhookPublicKeyPath: PUBKEY, origin: ORIGIN, chainId: 5042002,
    managerAddress: MANAGER, usdcAddress: USDC,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;

  for (const acct of [merchantAcct, subscriberAcct, otherAcct, formerAcct]) {
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
    const local = buildServer({ dbPath: DB, webhookPublicKeyPath: PUBKEY, origin: "http://localhost:3001", chainId: 5042002 });
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

  it("GET /api/config treats the zero-address placeholder as unset", async () => {
    const zero = `0x${"0".repeat(40)}`;
    const local = buildServer({ dbPath: DB, webhookPublicKeyPath: PUBKEY, origin: ORIGIN, chainId: 5042002, managerAddress: zero, usdcAddress: USDC });
    try {
      const r = await local.inject({ method: "GET", url: "/api/config" });
      assert.deepEqual(r.json(), { chainId: 5042002, managerAddress: null, usdcAddress: USDC });
    } finally {
      await local.close();
    }
  });

  it("GET /api/plans", async () => {
    const r = await get("/api/plans");
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 4);
    assert.equal(r.json[0].planId, "1");
    assert.equal(r.json[0].priceUsdc, "10.000000");
    assert.equal(r.json[0].retired, false);
    assert.equal(r.json[0].maxCycles, 0);
    assert.equal(r.json[0].introCycles, 0);
    // v2 terms
    const v2 = r.json[3];
    assert.equal(v2.retired, true);
    assert.equal(v2.transferable, true);
    assert.equal(v2.maxCycles, 2);
    assert.equal(v2.introPriceUsdc, "1.000000");
    assert.equal(v2.introCycles, 1);
  });

  it("GET /api/plans/:id serves one plan, so checkout never loads the list", async () => {
    const r = await get("/api/plans/4");
    assert.equal(r.status, 200);
    assert.equal(r.json.planId, "4");
    assert.equal(r.json.retired, true);
    assert.equal(r.json.introPriceUsdc, "1.000000");
    for (const id of ["99", "abc", "1x"]) assert.equal((await get(`/api/plans/${id}`)).status, 404, id);
  });

  it("GET /api/plans?merchant= serves one account's plans", async () => {
    const ids = async (url: string) => ((await get(url)).json as Array<{ planId: string }>).map((p) => p.planId);
    assert.deepEqual(await ids(`/api/plans?merchant=${OTHER.toLowerCase()}`), ["2", "3"]);
    assert.deepEqual(await ids(`/api/plans?merchant=${MERCHANT}`), ["1"]);
    assert.deepEqual(await ids(`/api/plans?merchant=${SAFE}`), []);
    assert.equal((await get("/api/plans?merchant=0x1234")).status, 400);
  });

  it("GET /api/plans pages by plan id", async () => {
    const ids = async (url: string) => ((await get(url)).json as Array<{ planId: string }>).map((p) => p.planId);
    assert.deepEqual(await ids("/api/plans?limit=2"), ["1", "2"]);
    assert.deepEqual(await ids("/api/plans?after=2&limit=2"), ["3", "4"]);
    assert.deepEqual(await ids("/api/plans?after=4"), []);
    for (const q of ["limit=0", "limit=abc", "after=-1", "after=1.5"]) {
      assert.equal((await get(`/api/plans?${q}`)).status, 400, q);
    }
  });

  it("GET /api/webhooks/public-key serves the SPKI PEM", async () => {
    const r = await get("/api/webhooks/public-key");
    assert.equal(r.status, 200);
    assert.equal(r.json.algorithm, "ed25519");
    assert.match(r.json.keyId, /^[0-9a-f]{16}$/);
    assert.ok(r.json.publicKey.includes("BEGIN PUBLIC KEY"));
    assert.equal(r.json.events.length, 13);
    assert.ok(r.json.events.includes("allowance.low"));
    assert.ok(r.json.events.includes("subscription.updated"));
    for (const e of ["subscription.completed", "subscription.transferred", "merchant.updated"]) {
      assert.ok(r.json.events.includes(e), e);
    }
  });

  it("GET /api/webhooks/public-key answers 503 until the keeper publishes a key, and never makes one", async () => {
    const missing = join(tmp, "not-published.pem");
    const local = buildServer({ dbPath: DB, webhookPublicKeyPath: missing, origin: ORIGIN, chainId: 5042002 });
    try {
      const r = await local.inject({ method: "GET", url: "/api/webhooks/public-key" });
      assert.equal(r.statusCode, 503);
      assert.equal(existsSync(missing), false);
    } finally {
      await local.close();
    }
  });
});

describe("merchant accounts (v2)", () => {
  it("lists the accounts an address owns and those offered to it", async () => {
    const other = await get("/api/accounts", OTHER);
    assert.equal(other.status, 200);
    assert.deepEqual(other.json.owned.map((a: any) => a.account), [OTHER, FORMER]);
    assert.deepEqual(other.json.owned[1], { account: FORMER, owner: OTHER, payout: SAFE, paidTo: SAFE, pendingOwner: MERCHANT });
    assert.deepEqual(other.json.owned[0], { account: OTHER, owner: OTHER, payout: null, paidTo: OTHER, pendingOwner: null });
    assert.deepEqual(other.json.offered, []);

    const merchant = await get("/api/accounts", MERCHANT);
    assert.deepEqual(merchant.json.owned.map((a: any) => a.account), [MERCHANT]);
    assert.deepEqual(merchant.json.offered.map((a: any) => a.account), [FORMER]);

    // FORMER handed its own account on: it owns nothing now.
    assert.deepEqual((await get("/api/accounts", FORMER)).json, { owned: [], offered: [] });
  });

  it("serves an account's data to its current owner only", async () => {
    const subs = await get(`/api/subscriptions?merchant=${FORMER}`, OTHER);
    assert.equal(subs.status, 200);
    assert.deepEqual(subs.json.map((s: any) => [s.subId, s.statusName]), [["5", "completed"], ["6", "active"]]);
    const m = await get(`/api/metrics?merchant=${FORMER.toLowerCase()}`, OTHER);
    assert.equal(m.status, 200);
    assert.equal(m.json.merchant, FORMER);
    assert.equal(m.json.completedSubs, 1);
    assert.equal((await get("/api/subscriptions/5", OTHER)).status, 200);

    // The previous owner lost access, its own address included.
    assert.equal((await get(`/api/subscriptions?merchant=${FORMER}`, FORMER)).status, 403);
    assert.equal((await get("/api/metrics", FORMER)).status, 403);
    assert.equal((await get("/api/webhooks", FORMER)).status, 403);
    assert.equal((await get("/api/subscriptions/5", FORMER)).status, 404);
    // A proposed owner has no access until it accepts.
    assert.equal((await get(`/api/metrics?merchant=${FORMER}`, MERCHANT)).status, 403);
  });

  it("registers webhooks under the account, for its owner", async () => {
    const r = await call("POST", "/api/webhooks", {
      as: OTHER, body: { merchant: FORMER, url: "https://8.8.4.4/former", events: ["merchant.updated"] },
    });
    assert.equal(r.status, 200, r.body);
    const hooks = await get(`/api/webhooks?merchant=${FORMER}`, OTHER);
    assert.deepEqual(hooks.json.map((h: any) => [h.merchant, h.url]), [[FORMER, "https://8.8.4.4/former"]]);
    assert.equal((await get("/api/webhooks", OTHER)).json.some((h: any) => h.url.includes("former")), false);
    assert.equal((await call("DELETE", `/api/webhooks/${r.json.id}`, { as: FORMER })).status, 404);
    assert.equal((await call("DELETE", `/api/webhooks/${r.json.id}`, { as: OTHER })).status, 200);
  });

  it("lists subscriptions offered to the signed-in wallet", async () => {
    const r = await get(`/api/subscriptions?pendingTransfer=${MERCHANT}`, MERCHANT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((s: any) => s.subId), ["6"]);
    assert.equal(r.json[0].pendingTransfer, MERCHANT);
    assert.equal((await get(`/api/subscriptions?pendingTransfer=${MERCHANT}`, SUBSCRIBER)).status, 403);
  });
});

describe("data is scoped to the signed-in address", () => {
  it("subscriptions: own merchant or subscriber view only", async () => {
    const r = await get(`/api/subscriptions?merchant=${MERCHANT}`, MERCHANT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((s: any) => s.subId), ["1", "2"]);
    assert.deepEqual(r.json.map((s: any) => s.ref), [REF, null]); // the merchant's own reference
    assert.deepEqual(r.json.map((s: any) => s.pausedByMerchant), [0, 0]); // the dashboard offers resume only at 1

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

  it("refuses a URL longer than 2048 characters", async () => {
    const r = await call("POST", "/api/webhooks", {
      as: MERCHANT, body: { url: `https://8.8.8.8/${"a".repeat(3000)}`, events: ["charge.succeeded"] },
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.includes("longer than"));
  });

  it("holds the cap when registrations arrive at the same time", async () => {
    // Each request awaits its URL check between counting and inserting; the
    // count is taken again just before the insert (M-1, 2026-10-24 review).
    // A slow DNS answer keeps every request inside that window, as an
    // attacker's own nameserver could.
    const lookup = dns.promises.lookup;
    (dns.promises as any).lookup = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return [{ address: "93.184.216.34", family: 4 }];
    };
    try {
      const before = (await get("/api/webhooks", OTHER)).json.length;
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call("POST", "/api/webhooks", {
        as: OTHER, body: { url: `https://hooks.example.org/race${i}`, events: ["charge.succeeded"] },
      })));
      assert.equal(results.filter((r) => r.status === 200).length, 5 - before);
      assert.equal((await get("/api/webhooks", OTHER)).json.length, 5);
    } finally {
      (dns.promises as any).lookup = lookup;
    }
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

  it("refuses a database the keeper recorded for another deployment", () => {
    const path = join(tmp, "other-deployment.db");
    const other = new LevyDb(path);
    other.bindDeployment(deploymentId(5042002, "0x00000000000000000000000000000000000000ee", USDC));
    other.close();
    assert.throws(
      () => buildServer({ dbPath: path, webhookPublicKeyPath: PUBKEY, origin: ORIGIN, chainId: 5042002, managerAddress: MANAGER, usdcAddress: USDC }),
      /belongs to/
    );
  });

  it("refuses to start holding the keeper key or the webhook signing key", () => {
    for (const secret of ["LEVY_KEEPER_KEY", "LEVY_WEBHOOK_KEY"]) {
      const saved = process.env[secret];
      process.env[secret] = "0xsecret";
      try {
        assert.throws(() => apiOptionsFromEnv(), new RegExp(`${secret} is set`));
      } finally {
        if (saved === undefined) delete process.env[secret];
        else process.env[secret] = saved;
      }
    }
  });

  it("accepts only a plain origin for LEVY_PUBLIC_ORIGIN, and normalizes it", () => {
    assert.equal(publicOrigin("https://app.levy.test", true), "https://app.levy.test");
    assert.equal(publicOrigin("https://App.Levy.test/", true), "https://app.levy.test");
    assert.equal(publicOrigin("https://app.levy.test:443", true), "https://app.levy.test");
    assert.equal(publicOrigin("http://localhost:3001", true), "http://localhost:3001");
    assert.equal(publicOrigin("http://app.levy.test", false), "http://app.levy.test");
    for (const bad of [
      "app.levy.test:443", // parses as scheme "app.levy.test:", origin "null"
      "localhost:3001",
      "app.levy.test",
      "ftp://app.levy.test",
      "https://user:pass@app.levy.test",
      "https://app.levy.test/dashboard",
      "https://app.levy.test/?x=1",
      "https://app.levy.test/#x",
      "",
    ]) {
      assert.throws(() => publicOrigin(bad, false), /LEVY_PUBLIC_ORIGIN/, bad);
    }
    // Plain http on a public host would send the session cookie without Secure.
    assert.throws(() => publicOrigin("http://app.levy.test", true), /https in production/);
  });

  it("refuses to start with a LEVY_PUBLIC_ORIGIN that is not an origin", () => {
    const saved = process.env.LEVY_PUBLIC_ORIGIN;
    try {
      process.env.LEVY_PUBLIC_ORIGIN = "app.levy.test:443";
      assert.throws(() => apiOptionsFromEnv(), /LEVY_PUBLIC_ORIGIN/);
      process.env.LEVY_PUBLIC_ORIGIN = "https://app.levy.test/";
      assert.equal(apiOptionsFromEnv().origin, "https://app.levy.test");
    } finally {
      if (saved === undefined) delete process.env.LEVY_PUBLIC_ORIGIN;
      else process.env.LEVY_PUBLIC_ORIGIN = saved;
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

    // The shared stylesheet and logo every page links, and the testnet bar.
    for (const page of [dash, portal, checkout]) {
      assert.ok(page.body.includes(`href="/public/app.css"`) && page.body.includes(`src="/public/logo.svg"`));
      assert.ok(page.body.includes(`id="testnetBar"`) && page.body.includes(`src="/public/network.js"`));
    }
    assert.equal((await get("/public/network.js")).status, 200);
    const css = await get("/public/app.css");
    assert.equal(css.status, 200);
    assert.ok(css.headers.get("content-type")?.includes("text/css"));
    assert.equal((await get("/public/logo.svg")).status, 200);
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

  it("sends nosniff everywhere and no-store on API responses, errors included", async () => {
    for (const path of ["/api/health", "/api/metrics", "/api/nope", "/", "/public/auth.js", "/public/nope.js"]) {
      const r = await get(path);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
    }
    for (const path of ["/api/health", "/api/metrics", `/api/subscriptions?merchant=${MERCHANT}`]) {
      const r = await get(path, MERCHANT);
      assert.equal(r.headers.get("cache-control"), "no-store", path);
    }
    assert.equal((await get("/api/metrics")).headers.get("cache-control"), "no-store", "401 too");
    assert.equal((await get("/public/auth.js")).headers.get("cache-control"), null);
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { LevyDb } from "../../keeper/src/db.js";
import { SESSION_TTL_SEC } from "../src/auth.js";
import { buildServer } from "../src/server.js";

// Sign-in enforcement edges not covered by api.test.ts: session and challenge
// expiry, how the Authorization header is read, the pending-challenge cap, and
// that the Origin rule applies to cookie sessions only. Sessions and
// challenges are written straight into the DB where a test needs one that is
// already expired.

const tmp = mkdtempSync(join(tmpdir(), "levy-auth-"));
const DB = join(tmp, "auth.db");
const KEY = join(tmp, "wh-key.pem");
const ORIGIN = "https://app.levy.test";
const acct = privateKeyToAccount(`0x${"44".repeat(32)}`);
const other = privateKeyToAccount(`0x${"55".repeat(32)}`);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

let app: FastifyInstance;
let base: string;
let db: LevyDb; // a second handle on the API's SQLite file

before(async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(KEY, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  app = buildServer({ dbPath: DB, webhookKeyPath: KEY, origin: ORIGIN, chainId: 5042002, webhookAllowPrivate: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  db = new LevyDb(DB);
});

after(async () => {
  db?.close();
  await app?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, headers: r.headers };
}

async function signIn(a: PrivateKeyAccount, extra: Record<string, unknown> = {}) {
  const c = await req("POST", "/api/auth/challenge", {}, { address: a.address });
  const signature = await a.signMessage({ message: c.json.message });
  return req("POST", "/api/auth/verify", {}, { nonce: c.json.nonce, signature, ...extra });
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("session lifetime", () => {
  it("issues a session that expires SESSION_TTL_SEC (24h) after sign-in", async () => {
    const before = now();
    const r = await signIn(acct);
    assert.equal(r.status, 200);
    assert.equal(SESSION_TTL_SEC, 86_400);
    assert.ok(r.json.expiresAt >= before + SESSION_TTL_SEC && r.json.expiresAt <= now() + SESSION_TTL_SEC);
  });

  it("refuses an expired session token", async () => {
    // Expired row written last: createSession prunes rows expired as of its nowSec.
    db.createSession(sha256("live-token"), acct.address, now() + 3600, now());
    db.createSession(sha256("expired-token"), acct.address, now() - 1, now() - 10);
    assert.ok(db.getSession(sha256("expired-token"), now() - 5), "expired row is still stored");
    assert.equal((await req("GET", "/api/auth/session", bearer("expired-token"))).status, 401);
    assert.equal((await req("GET", "/api/funds", bearer("expired-token"))).status, 401);
    const live = await req("GET", "/api/auth/session", bearer("live-token"));
    assert.equal(live.status, 200);
    assert.equal(live.json.address, acct.address);
  });

  it("stores only the token's hash, never the token", async () => {
    const r = await signIn(acct);
    const token: string = r.json.token;
    // The raw token is not a valid key; its SHA-256 is.
    assert.equal(db.getSession(token, now()), undefined);
    assert.equal(db.getSession(sha256(token), now())?.address, acct.address);
  });

  it("logout revokes only the session it was sent with", async () => {
    const a = (await signIn(acct)).json.token;
    const b = (await signIn(acct)).json.token;
    assert.equal((await req("POST", "/api/auth/logout", bearer(a))).status, 200);
    assert.equal((await req("GET", "/api/auth/session", bearer(a))).status, 401);
    assert.equal((await req("GET", "/api/auth/session", bearer(b))).status, 200);
    // Logging out again with the revoked token is a 401, not a silent success.
    assert.equal((await req("POST", "/api/auth/logout", bearer(a))).status, 401);
  });
});

describe("challenges", () => {
  it("refuses an expired challenge even with a valid signature", async () => {
    const message = "expired challenge";
    db.createChallenge("stale-nonce", acct.address, message, now() - 1, now() - 400);
    const signature = await acct.signMessage({ message });
    const r = await req("POST", "/api/auth/verify", {}, { nonce: "stale-nonce", signature });
    assert.equal(r.status, 401);
  });

  it("returns a checksummed address for a lowercase challenge", async () => {
    const c = await req("POST", "/api/auth/challenge", {}, { address: acct.address.toLowerCase() });
    const signature = await acct.signMessage({ message: c.json.message });
    const r = await req("POST", "/api/auth/verify", {}, { nonce: c.json.nonce, signature });
    assert.equal(r.json.address, acct.address);
  });

  it("rejects a hex signature that cannot be parsed, and burns the challenge", async () => {
    const c = await req("POST", "/api/auth/challenge", {}, { address: acct.address });
    assert.equal((await req("POST", "/api/auth/verify", {}, { nonce: c.json.nonce, signature: "0x1234" })).status, 401);
    const signature = await acct.signMessage({ message: c.json.message });
    assert.equal((await req("POST", "/api/auth/verify", {}, { nonce: c.json.nonce, signature })).status, 401);
  });

  it("rejects missing or non-string fields", async () => {
    assert.equal((await req("POST", "/api/auth/challenge", {}, {})).status, 400);
    assert.equal((await req("POST", "/api/auth/challenge", {}, { address: 42 })).status, 400);
    assert.equal((await req("POST", "/api/auth/verify", {}, { signature: "0x00" })).status, 400);
    assert.equal((await req("POST", "/api/auth/verify", {}, { nonce: 1, signature: "0x00" })).status, 400);
    assert.equal((await req("POST", "/api/auth/verify", {}, { nonce: "n" })).status, 400);
  });

  it("only cookie: true (the boolean) switches to a cookie", async () => {
    const r = await signIn(acct, { cookie: "true" });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.token, "string");
    assert.equal(r.headers.get("set-cookie"), null);
  });

  it("caps pending challenges at 10,000; used ones stop counting", async () => {
    // A server on its own DB, so the flood does not touch the other tests.
    const dir = mkdtempSync(join(tmpdir(), "levy-auth-cap-"));
    const capDb = join(dir, "cap.db");
    const capped = buildServer({ dbPath: capDb, webhookKeyPath: KEY, origin: ORIGIN, chainId: 5042002 });
    await capped.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(capped.server.address() as { port: number }).port}/api/auth/challenge`;
    const post = () => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: acct.address }),
    });
    const h = new LevyDb(capDb);
    try {
      const t = now();
      for (let i = 0; i < 9_999; i++) h.createChallenge(`n${i}`, acct.address, "m", t + 300, t);
      assert.equal((await post()).status, 200); // the 10,000th
      assert.equal((await post()).status, 503);
      // Used (consumed) challenges no longer count.
      for (let i = 0; i < 5; i++) h.takeChallenge(`n${i}`, t);
      assert.equal((await post()).status, 200);
    } finally {
      h.close();
      await capped.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("how the token is read", () => {
  let token: string;
  before(async () => {
    token = (await signIn(acct)).json.token;
  });

  it("needs the exact 'Bearer ' scheme", async () => {
    for (const authorization of [token, `bearer ${token}`, `Basic ${token}`, "Bearer", "Bearer ", `Token ${token}`]) {
      assert.equal((await req("GET", "/api/auth/session", { authorization })).status, 401, authorization);
    }
    assert.equal((await req("GET", "/api/auth/session", { authorization: `Bearer   ${token}  ` })).status, 200);
  });

  it("does not fall back to the cookie when an Authorization header is present", async () => {
    const r = await signIn(acct, { cookie: true });
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal((await req("GET", "/api/auth/session", { cookie })).status, 200);
    assert.equal((await req("GET", "/api/auth/session", { cookie, authorization: "Basic x" })).status, 401);
  });

  it("finds the session cookie among others", async () => {
    const r = await signIn(acct, { cookie: true });
    const pair = (r.headers.get("set-cookie") ?? "").split(";")[0];
    const s = await req("GET", "/api/auth/session", { cookie: `theme=dark; ${pair}; other=1` });
    assert.equal(s.status, 200);
  });

  it("applies the Origin rule to cookie sessions only: bearer writes need no Origin", async () => {
    // Reaches the handler (404 for a missing webhook), not the 403 a cookie gets.
    const r = await req("PATCH", "/api/webhooks/999999", bearer(token), { active: true });
    assert.equal(r.status, 404);
    const del = await req("DELETE", "/api/webhooks/999999", { ...bearer(token), origin: "https://evil.example" });
    assert.equal(del.status, 404);
  });

  it("lets cookie sessions read from any origin but write only from its own", async () => {
    const r = await signIn(acct, { cookie: true });
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal((await req("GET", "/api/funds", { cookie, origin: "https://evil.example" })).status, 200);
    assert.equal((await req("DELETE", "/api/webhooks/999999", { cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await req("DELETE", "/api/webhooks/999999", { cookie, origin: ORIGIN })).status, 404);
    // Origin must match exactly, scheme and port included.
    assert.equal((await req("DELETE", "/api/webhooks/999999", { cookie, origin: "http://app.levy.test" })).status, 403);
    assert.equal((await req("DELETE", "/api/webhooks/999999", { cookie, origin: `${ORIGIN}:443` })).status, 403);
  });
});

describe("a session only reaches its own address", () => {
  it("refuses another address in a query or body with 403, and a malformed one with 400", async () => {
    const t = (await signIn(acct)).json.token;
    for (const path of ["/api/metrics", "/api/dunning", "/api/charges", "/api/webhooks"]) {
      assert.equal((await req("GET", `${path}?merchant=${other.address}`, bearer(t))).status, 403, path);
      assert.equal((await req("GET", `${path}?merchant=0x123`, bearer(t))).status, 400, path);
      assert.equal((await req("GET", `${path}?merchant=${acct.address.toLowerCase()}`, bearer(t))).status, 200, path);
    }
    assert.equal((await req("GET", `/api/subscriptions?subscriber=${other.address}`, bearer(t))).status, 403);
    const post = await req("POST", "/api/webhooks", bearer(t), {
      merchant: other.address, url: "https://example.com/hook", events: ["charge.succeeded"],
    });
    assert.equal(post.status, 403);
  });
});

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAddress, isAddress, isHex, verifyMessage } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { LevyDb } from "../../keeper/src/db.js";

/**
 * Sign-In with Ethereum (EIP-4361). The server writes the whole message, bound
 * to the configured origin, so a phishing site cannot obtain a signature that
 * works here (wallets also warn when the message's domain is not the page's).
 * A valid signature buys a 24h session token; only its SHA-256 is stored.
 * EOA signatures only for now: contract wallets (ERC-1271) need an RPC call.
 *
 * Backends send the token as `Authorization: Bearer`. The pages ask for a
 * cookie instead (`cookie: true` on verify): HttpOnly, so page scripts never
 * see the token, and SameSite=Strict. A cookie is sent without the page asking,
 * so a write authenticated by one must also carry this origin in `Origin`;
 * that stops sibling sites such as getlevy.xyz, which SameSite counts as the
 * same site. Over https the cookie is `__Host-` prefixed, which stops a sibling
 * subdomain from planting its own.
 */
export interface AuthOptions {
  /** Origin the dashboard is served from, e.g. https://app.getlevy.xyz. */
  origin: string;
  chainId: number;
}

const CHALLENGE_TTL_SEC = 5 * 60;
/** Bounds what an unauthenticated flood can write; real sign-ins need a handful. */
const MAX_PENDING_CHALLENGES = 10_000;
export const SESSION_TTL_SEC = 24 * 3600;

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Ends the request with `status` and `{ message }` (Fastify's error handler). */
export function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  throw err;
}

/** The signed-in address (checksummed), or a 401. */
export type RequireSession = (req: FastifyRequest) => string;

/** One cookie from the Cookie header, or "". */
function readCookie(req: FastifyRequest, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/** Registers the sign-in routes and returns the session check for every other route. */
export function registerAuthRoutes(app: FastifyInstance, db: LevyDb, opts: AuthOptions): RequireSession {
  const { host: domain, origin, protocol } = new URL(opts.origin);
  const secure = protocol === "https:";
  // Plain http is local development only; browsers refuse __Host- without Secure.
  const cookieName = secure ? "__Host-levy_session" : "levy_session";
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;

  /** The request's token and whether it came from the cookie. */
  function tokenOf(req: FastifyRequest): { token: string; fromCookie: boolean } {
    const header = req.headers.authorization;
    if (header !== undefined) {
      return { token: header.startsWith("Bearer ") ? header.slice(7).trim() : "", fromCookie: false };
    }
    return { token: readCookie(req, cookieName), fromCookie: true };
  }

  /** The signed-in address (checksummed), or a 401 (403 for a cross-origin cookie write). */
  function requireSession(req: FastifyRequest): string {
    const { token, fromCookie } = tokenOf(req);
    if (!token) fail(401, "sign in required");
    const session = db.getSession(sha256(token), now());
    if (!session) fail(401, "session expired or invalid");
    if (fromCookie && req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== origin) {
      fail(403, "cross-origin request refused");
    }
    return session.address;
  }

  app.post("/api/auth/challenge", async (req) => {
    const body = req.body as { address?: unknown };
    if (typeof body?.address !== "string" || !isAddress(body.address, { strict: false })) {
      fail(400, "address must be a 0x address");
    }
    const address = getAddress(body.address);
    const issued = now();
    if (db.pendingChallenges(issued) >= MAX_PENDING_CHALLENGES) {
      fail(503, "too many pending sign-ins; retry in a few minutes");
    }
    // crypto-grade nonce (viem's generateSiweNonce uses Math.random).
    const nonce = randomBytes(16).toString("hex");
    const message = createSiweMessage({
      domain,
      address,
      statement: "Sign in to Levy. This is not a transaction and costs no gas.",
      uri: opts.origin,
      version: "1",
      chainId: opts.chainId,
      nonce,
      issuedAt: new Date(issued * 1000),
      expirationTime: new Date((issued + CHALLENGE_TTL_SEC) * 1000),
    });
    db.createChallenge(nonce, address, message, issued + CHALLENGE_TTL_SEC, issued);
    return { nonce, message };
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const body = req.body as { nonce?: unknown; signature?: unknown; cookie?: unknown };
    if (typeof body?.nonce !== "string" || typeof body?.signature !== "string" || !isHex(body.signature)) {
      fail(400, "nonce and hex signature required");
    }
    const challenge = db.takeChallenge(body.nonce, now());
    if (!challenge) fail(401, "challenge expired or already used");
    let valid = false;
    try {
      valid = await verifyMessage({
        address: challenge.address as `0x${string}`,
        message: challenge.message,
        signature: body.signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid) fail(401, "signature does not match the address");

    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + SESSION_TTL_SEC;
    db.createSession(sha256(token), challenge.address, expiresAt, now());
    if (body.cookie === true) {
      reply.header("set-cookie", cookie(token, SESSION_TTL_SEC));
      return { address: challenge.address, expiresAt };
    }
    return { token, address: challenge.address, expiresAt };
  });

  app.get("/api/auth/session", async (req) => {
    return { address: requireSession(req) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    requireSession(req);
    const { token, fromCookie } = tokenOf(req);
    db.deleteSession(sha256(token));
    if (fromCookie) reply.header("set-cookie", cookie("", 0));
    return { ok: true };
  });

  return requireSession;
}

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAddress, isAddress, isHex, verifyMessage } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { LevyDb } from "../../keeper/src/db.js";

/**
 * Sign-In with Ethereum (EIP-4361). The server writes the whole message, bound
 * to the configured origin, so a phishing site cannot obtain a signature that
 * works here (wallets also warn when the message's domain is not the page's).
 * A valid signature buys a 24h bearer token; only its SHA-256 is stored.
 * EOA signatures only for now: contract wallets (ERC-1271) need an RPC call.
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

function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  throw err;
}

/** The signed-in address (checksummed), or a 401. */
export function requireSession(db: LevyDb, req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) fail(401, "sign in required");
  const session = db.getSession(sha256(token), now());
  if (!session) fail(401, "session expired or invalid");
  return session.address;
}

export function registerAuthRoutes(app: FastifyInstance, db: LevyDb, opts: AuthOptions): void {
  const domain = new URL(opts.origin).host;

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

  app.post("/api/auth/verify", async (req) => {
    const body = req.body as { nonce?: unknown; signature?: unknown };
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
    return { token, address: challenge.address, expiresAt };
  });

  app.get("/api/auth/session", async (req) => {
    return { address: requireSession(db, req) };
  });

  app.post("/api/auth/logout", async (req) => {
    requireSession(db, req);
    const token = (req.headers.authorization ?? "").slice(7).trim();
    db.deleteSession(sha256(token));
    return { ok: true };
  });
}

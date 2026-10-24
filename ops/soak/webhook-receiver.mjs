// Webhook receiver for the testnet soak (ops/testnet-soak.md). It accepts Levy
// deliveries at POST /soak-hooks, checks each one exactly as
// docs/merchant-guide.md tells merchants to, written independently of the
// keeper's own verifyDelivery, and appends one JSON line per delivery to
// LOG_PATH. It answers 200 even when a check fails, so that the keeper's delivery
// counts and the signature results can be read separately; ops/soak-status.sh
// reports any failure.
//
// The endpoint is public, so only deliveries with a valid signature are logged
// in full. Anything else is logged without its body, and only while the log is
// under MAX_LOG_BYTES, so nobody can fill the shared disk through it (M-4,
// 2026-10-24 infrastructure review).
//
// No dependencies: Node 24's fetch and node:crypto.
import { createServer } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

const PORT = Number(process.env.PORT ?? 3002);
const KEY_URL = process.env.PUBLIC_KEY_URL ?? "https://app.getlevy.xyz/api/webhooks/public-key";
const LOG_PATH = process.env.LOG_PATH ?? "/data/hooks.jsonl";
// The id Levy gave this endpoint at registration: a delivery signed for any
// other webhook does not verify here.
const WEBHOOK_ID = process.env.WEBHOOK_ID ?? "";
// The soak merchant's address; deliveries whose payload names another are flagged.
const MERCHANT = (process.env.MERCHANT ?? "").toLowerCase();
const MAX_SKEW_SECONDS = 300; // the merchant guide's replay window
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const DELIVERY_ID_RE = /^[0-9a-f]{16}-[0-9]+$/;
// The event types in docs/merchant-guide.md. Anything else is rejected.
const EVENTS = new Set([
  "subscription.created", "subscription.updated", "charge.succeeded", "charge.failed",
  "dunning.started", "subscription.paused", "subscription.resumed", "subscription.cancelled",
  "invoice.ready", "allowance.low",
]);

let publicKey = null;
let expectedKeyId = null;

async function loadKey() {
  const r = await fetch(KEY_URL);
  if (!r.ok) throw new Error(`public key: HTTP ${r.status}`);
  const j = await r.json();
  publicKey = createPublicKey(j.publicKey);
  expectedKeyId = j.keyId;
  console.log(`public key loaded (keyId ${j.keyId})`);
}

function signatureValid(timestamp, deliveryId, event, rawBody, signature) {
  if (!publicKey || !WEBHOOK_ID || !timestamp || !EVENTS.has(event) || !signature) return false;
  if (!DELIVERY_ID_RE.test(String(deliveryId))) return false;
  try {
    const signed = Buffer.from(`${timestamp}.${deliveryId}.${WEBHOOK_ID}.${event}.${rawBody}`, "utf-8");
    return verify(null, signed, publicKey, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

// Delivery ids already accepted, restored from the log so a restart does not
// count redeliveries as new. Read line by line: a whole-file string has a size limit.
const seen = new Set();
let logBytes = 0;
if (existsSync(LOG_PATH)) {
  logBytes = statSync(LOG_PATH).size;
  for await (const line of createInterface({ input: createReadStream(LOG_PATH, "utf-8"), crlfDelay: Infinity })) {
    try {
      const e = JSON.parse(line);
      if (e.sigValid) seen.add(e.delivery);
    } catch {}
  }
}

/** Append one log line; false when the write failed (for example a full disk). */
function log(entry) {
  const line = JSON.stringify(entry) + "\n";
  try {
    appendFileSync(LOG_PATH, line);
    logBytes += Buffer.byteLength(line);
    return true;
  } catch (e) {
    console.error(`log write failed: ${e.code ?? e.message}`);
    return false;
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/soak-hooks/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end(publicKey ? "ok" : "no key yet");
    return;
  }
  if (req.method !== "POST" || req.url !== "/soak-hooks") {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  const h = req.headers;
  const timestamp = h["x-levy-timestamp"];
  const deliveryId = h["x-levy-delivery"];
  const event = h["x-levy-event"];
  const signature = h["x-levy-signature"];

  if (!publicKey) await loadKey().catch((e) => console.error(e.message));
  let sigValid = signatureValid(timestamp, deliveryId, event, raw, signature);
  if (!sigValid && h["x-levy-key-id"] !== expectedKeyId) {
    // The key may have been rotated: reload once and check again.
    await loadKey().catch((e) => console.error(e.message));
    sigValid = signatureValid(timestamp, deliveryId, event, raw, signature);
  }

  const skewSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
  const duplicate = sigValid && seen.has(deliveryId);
  if (sigValid) seen.add(deliveryId);
  let body = null;
  if (sigValid) {
    try {
      body = JSON.parse(raw);
    } catch {}
  }
  const merchantOk = !MERCHANT || String(body?.merchant ?? "").toLowerCase() === MERCHANT;

  const entry = {
    receivedAt: new Date().toISOString(),
    // Header values are capped: an unsigned request can put anything in them.
    event: event ? String(event).slice(0, 64) : null,
    delivery: deliveryId ? String(deliveryId).slice(0, 64) : null,
    webhook: h["x-levy-webhook"] ? String(h["x-levy-webhook"]).slice(0, 20) : null,
    keyId: h["x-levy-key-id"] ? String(h["x-levy-key-id"]).slice(0, 32) : null,
    keyIdMatches: h["x-levy-key-id"] === expectedKeyId,
    sigValid,
    merchantOk,
    skewSeconds,
    fresh: Math.abs(skewSeconds) <= MAX_SKEW_SECONDS,
    duplicate,
    body, // null unless the signature is valid
  };
  if (sigValid) {
    // A genuine delivery that cannot be recorded is answered 500, so Levy retries it.
    if (!log(entry)) return res.writeHead(500).end();
  } else if (logBytes < MAX_LOG_BYTES) {
    log(entry);
  }
  console.log(
    `${entry.receivedAt} ${entry.event} #${entry.delivery} sig=${sigValid ? "ok" : "BAD"}${merchantOk ? "" : " OTHER-MERCHANT"} skew=${skewSeconds}s${duplicate ? " duplicate" : ""}`
  );
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
});

if (!WEBHOOK_ID) console.error("WEBHOOK_ID is not set: every delivery will fail the signature check");
server.listen(PORT, "0.0.0.0", () => console.log(`soak webhook receiver on :${PORT}, webhook ${WEBHOOK_ID || "unset"}, logging to ${LOG_PATH}`));
loadKey().catch((e) => console.error(`public key not loaded yet: ${e.message}`));

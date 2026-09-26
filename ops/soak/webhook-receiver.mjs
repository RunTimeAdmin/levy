// Webhook receiver for the testnet soak (ops/testnet-soak.md). It accepts Levy
// deliveries at POST /soak-hooks, checks each one exactly as
// docs/merchant-guide.md tells merchants to, written independently of the
// keeper's own verifyDelivery, and appends one JSON line per delivery to
// LOG_PATH. It answers 200 even when a check fails, so that the keeper's delivery
// counts and the signature results can be read separately; ops/soak/status.mjs
// reports any failure.
//
// No dependencies: Node 24's fetch and node:crypto.
import { createServer } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 3002);
const KEY_URL = process.env.PUBLIC_KEY_URL ?? "https://app.getlevy.xyz/api/webhooks/public-key";
const LOG_PATH = process.env.LOG_PATH ?? "/data/hooks.jsonl";
const MAX_SKEW_SECONDS = 300; // the merchant guide's replay window
const MAX_BODY_BYTES = 64 * 1024;

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

function signatureValid(timestamp, deliveryId, rawBody, signature) {
  if (!publicKey || !timestamp || !deliveryId || !signature) return false;
  try {
    const signed = Buffer.from(`${timestamp}.${deliveryId}.${rawBody}`, "utf-8");
    return verify(null, signed, publicKey, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

// Delivery ids already accepted, restored from the log so a restart does not
// count redeliveries as new.
const seen = new Set();
if (existsSync(LOG_PATH)) {
  for (const line of readFileSync(LOG_PATH, "utf-8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.sigValid) seen.add(e.delivery);
    } catch {}
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
  const signature = h["x-levy-signature"];

  if (!publicKey) await loadKey().catch((e) => console.error(e.message));
  let sigValid = signatureValid(timestamp, deliveryId, raw, signature);
  if (!sigValid && h["x-levy-key-id"] !== expectedKeyId) {
    // The key may have been rotated: reload once and check again.
    await loadKey().catch((e) => console.error(e.message));
    sigValid = signatureValid(timestamp, deliveryId, raw, signature);
  }

  const skewSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
  const duplicate = seen.has(deliveryId);
  if (sigValid) seen.add(deliveryId);
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {}

  const entry = {
    receivedAt: new Date().toISOString(),
    event: h["x-levy-event"] ?? null,
    delivery: deliveryId ?? null,
    keyId: h["x-levy-key-id"] ?? null,
    keyIdMatches: h["x-levy-key-id"] === expectedKeyId,
    sigValid,
    skewSeconds,
    fresh: Math.abs(skewSeconds) <= MAX_SKEW_SECONDS,
    duplicate,
    body,
  };
  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  console.log(
    `${entry.receivedAt} ${entry.event} #${entry.delivery} sig=${sigValid ? "ok" : "BAD"} skew=${skewSeconds}s${duplicate ? " duplicate" : ""}`
  );
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
});

server.listen(PORT, "0.0.0.0", () => console.log(`soak webhook receiver on :${PORT}, logging to ${LOG_PATH}`));
loadKey().catch((e) => console.error(`public key not loaded yet: ${e.message}`));

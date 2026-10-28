export interface LevyConfig {
  rpcUrl: string;
  chainId: number;
  managerAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
  keeperKey: `0x${string}`;
  pollIntervalMs: number;
  /** Retry offsets in days after a failed pull, by attempt number (1-based). */
  dunningScheduleDays: number[];
  /**
   * Failed charges in a row the keeper pays gas to record for one
   * subscription. Past that it sends a retry only when the subscriber's
   * funds cover the charge, so a subscription that never pays costs the
   * keeper at most this many transactions.
   */
  maxSponsoredFailures: number;
  dbPath: string;
  /** How far back to scan on first run (blocks). */
  initialLookbackBlocks: number;
  /** Blocks per eth_getLogs request. Arc RPCs cap the range (dRPC under 1,000). */
  logChunkBlocks: number;
  /** Path of the Ed25519 webhook signing key (generated on first run). Keeper only. */
  webhookKeyPath: string;
  /** Where the keeper publishes the public half for the API to serve. */
  webhookPublicKeyPath: string;
  /** Optional inline signing key: PEM PKCS#8 or base64 32-byte seed. */
  webhookKey?: string;
  /** Allow http and private-address webhook URLs. Local development only. */
  webhookAllowPrivate: boolean;
  /** Milliseconds between webhook delivery passes (separate from charge cycles). */
  webhookPollMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

/**
 * A whole number of at least `min`, or a startup error naming the variable.
 * Without this a typo becomes NaN: LEVY_POLL_MS=30s makes both loops spin with
 * no pause (setTimeout treats NaN as 1 ms) and hammer the RPC, and
 * LEVY_LOG_CHUNK_BLOCKS=0 never leaves the log range loop.
 */
function integer(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < min) {
    throw new Error(`env var ${name} must be a whole number of at least ${min} (got ${JSON.stringify(raw)})`);
  }
  return v;
}

function dunningDays(): number[] {
  const raw = process.env.LEVY_DUNNING_DAYS || "1,3,7";
  const days = raw.split(",").map((d) => Number(d.trim()));
  if (days.some((d) => !Number.isFinite(d) || d <= 0)) {
    throw new Error(`env var LEVY_DUNNING_DAYS must be positive day counts such as 1,3,7 (got ${JSON.stringify(raw)})`);
  }
  return days;
}

export function loadConfig(): LevyConfig {
  return {
    rpcUrl: process.env.LEVY_RPC_URL ?? "http://127.0.0.1:8545",
    chainId: integer("LEVY_CHAIN_ID", 5042, 1),
    managerAddress: required("LEVY_MANAGER_ADDRESS") as `0x${string}`,
    usdcAddress: required("LEVY_USDC_ADDRESS") as `0x${string}`,
    keeperKey: required("LEVY_KEEPER_KEY") as `0x${string}`,
    pollIntervalMs: integer("LEVY_POLL_MS", 30_000, 100),
    dunningScheduleDays: dunningDays(),
    maxSponsoredFailures: integer("LEVY_MAX_SPONSORED_FAILURES", 6, 1),
    dbPath: process.env.LEVY_DB_PATH ?? "./levy.db",
    initialLookbackBlocks: integer("LEVY_LOOKBACK_BLOCKS", 5000, 0),
    logChunkBlocks: integer("LEVY_LOG_CHUNK_BLOCKS", 500, 1),
    webhookKeyPath: process.env.LEVY_WEBHOOK_KEY_PATH ?? "./webhook-signing-key.pem",
    webhookPublicKeyPath: process.env.LEVY_WEBHOOK_PUBLIC_KEY_PATH ?? "./webhook-public-key.pem",
    webhookKey: process.env.LEVY_WEBHOOK_KEY,
    webhookAllowPrivate: process.env.LEVY_WEBHOOK_ALLOW_PRIVATE === "1",
    webhookPollMs: integer("LEVY_WEBHOOK_POLL_MS", 5_000, 100),
  };
}

/**
 * `text` with the RPC URL cut down to its origin. Provider URLs carry the API
 * key in the path or query (Alchemy, Infura, QuickNode, dRPC's dkey), and viem
 * puts the whole URL into its error messages (it strips only user:pass), so
 * every logged RPC error would otherwise write the key to the logs.
 */
export function redactRpcUrl(text: string, rpcUrl: string | undefined = process.env.LEVY_RPC_URL): string {
  if (!rpcUrl) return text;
  let origin: string;
  let forms: string[];
  try {
    const u = new URL(rpcUrl);
    origin = u.origin;
    const bare = new URL(rpcUrl);
    bare.username = "";
    bare.password = "";
    forms = [rpcUrl, u.href, bare.href, bare.href.replace(/\/$/, "")];
  } catch {
    return text.split(rpcUrl).join("<rpc url>");
  }
  // Longest first, so a shorter form never leaves the tail of a longer one.
  for (const f of [...new Set(forms)].sort((a, b) => b.length - a.length)) {
    if (f.length > origin.length + 1) text = text.split(f).join(`${origin}/<redacted>`);
  }
  return text;
}

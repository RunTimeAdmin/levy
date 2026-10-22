export interface LevyConfig {
  rpcUrl: string;
  chainId: number;
  managerAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
  keeperKey: `0x${string}`;
  pollIntervalMs: number;
  /** Retry offsets in days after a failed pull, by attempt number (1-based). */
  dunningScheduleDays: number[];
  dbPath: string;
  /** How far back to scan on first run (blocks). */
  initialLookbackBlocks: number;
  /** Blocks per eth_getLogs request. Arc RPCs cap the range (dRPC under 1,000). */
  logChunkBlocks: number;
  /** Path of the Ed25519 webhook signing key (generated on first run). */
  webhookKeyPath: string;
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

const positive = (n: number) => Number.isFinite(n) && n > 0;
const positiveInt = (n: number) => Number.isSafeInteger(n) && n > 0;
const nonNegativeInt = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * A numeric env var, or `fallback` when it is unset. Refused at boot when the
 * keeper could not run on it: a chunk size of 0 loops forever in logRanges, a
 * NaN interval becomes a ~1ms busy loop against the RPC, and a NaN chunk size
 * fails every cycle in BigInt().
 */
function numeric(name: string, fallback: number, ok: (n: number) => boolean, what: string): number {
  const raw = process.env[name];
  const v = raw === undefined ? fallback : Number(raw);
  if (!ok(v)) throw new Error(`${name} must be ${what}, got "${raw}"`);
  return v;
}

function dunningDays(): number[] {
  const raw = process.env.LEVY_DUNNING_DAYS ?? "1,3,7";
  const days = raw.split(",").map(Number);
  if (!days.every(positive)) {
    throw new Error(`LEVY_DUNNING_DAYS must be comma-separated positive day counts, got "${raw}"`);
  }
  return days;
}

export function loadConfig(): LevyConfig {
  return {
    rpcUrl: process.env.LEVY_RPC_URL ?? "http://127.0.0.1:8545",
    chainId: numeric("LEVY_CHAIN_ID", 5042, positiveInt, "a positive integer"),
    managerAddress: required("LEVY_MANAGER_ADDRESS") as `0x${string}`,
    usdcAddress: required("LEVY_USDC_ADDRESS") as `0x${string}`,
    keeperKey: required("LEVY_KEEPER_KEY") as `0x${string}`,
    pollIntervalMs: numeric("LEVY_POLL_MS", 30_000, positive, "a positive number of milliseconds"),
    dunningScheduleDays: dunningDays(),
    dbPath: process.env.LEVY_DB_PATH ?? "./levy.db",
    initialLookbackBlocks: numeric("LEVY_LOOKBACK_BLOCKS", 5000, nonNegativeInt, "a whole number of blocks"),
    logChunkBlocks: numeric("LEVY_LOG_CHUNK_BLOCKS", 500, positiveInt, "a positive whole number of blocks"),
    webhookKeyPath: process.env.LEVY_WEBHOOK_KEY_PATH ?? "./webhook-signing-key.pem",
    webhookKey: process.env.LEVY_WEBHOOK_KEY,
    webhookAllowPrivate: process.env.LEVY_WEBHOOK_ALLOW_PRIVATE === "1",
    webhookPollMs: numeric("LEVY_WEBHOOK_POLL_MS", 5_000, positive, "a positive number of milliseconds"),
  };
}

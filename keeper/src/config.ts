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

export function loadConfig(): LevyConfig {
  return {
    rpcUrl: process.env.LEVY_RPC_URL ?? "http://127.0.0.1:8545",
    chainId: Number(process.env.LEVY_CHAIN_ID ?? 5042),
    managerAddress: required("LEVY_MANAGER_ADDRESS") as `0x${string}`,
    usdcAddress: required("LEVY_USDC_ADDRESS") as `0x${string}`,
    keeperKey: required("LEVY_KEEPER_KEY") as `0x${string}`,
    pollIntervalMs: Number(process.env.LEVY_POLL_MS ?? 30_000),
    dunningScheduleDays: (process.env.LEVY_DUNNING_DAYS ?? "1,3,7")
      .split(",")
      .map(Number),
    dbPath: process.env.LEVY_DB_PATH ?? "./levy.db",
    initialLookbackBlocks: Number(process.env.LEVY_LOOKBACK_BLOCKS ?? 5000),
    webhookKeyPath: process.env.LEVY_WEBHOOK_KEY_PATH ?? "./webhook-signing-key.pem",
    webhookKey: process.env.LEVY_WEBHOOK_KEY,
    webhookAllowPrivate: process.env.LEVY_WEBHOOK_ALLOW_PRIVATE === "1",
    webhookPollMs: Number(process.env.LEVY_WEBHOOK_POLL_MS ?? 5_000),
  };
}

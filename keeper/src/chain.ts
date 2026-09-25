import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LevyConfig } from "./config.js";

const ABI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "abi");

function loadAbi(name: string) {
  return JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`), "utf-8"));
}

export const managerAbi = loadAbi("SubscriptionManager");
export const usdcAbi = loadAbi("MockUSDC"); // standard ERC-20 surface; swap for mainnet USDC ABI

export const arcMainnet = {
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
} as const satisfies Chain;

export interface ChainClients {
  public: PublicClient;
  wallet: WalletClient;
  account: Account;
  // Loosely typed: the ABI is loaded from JSON at runtime. Call sites cast
  // read/write results as needed.
  manager: any;
  chain: Chain;
}

export function createClients(cfg: LevyConfig): ChainClients {
  const chain = { ...arcMainnet, id: cfg.chainId } as Chain;
  const account = privateKeyToAccount(cfg.keeperKey);
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const manager = getContract({
    address: cfg.managerAddress,
    abi: managerAbi,
    client: { public: publicClient, wallet: walletClient },
  });
  return { public: publicClient, wallet: walletClient, account, manager, chain };
}

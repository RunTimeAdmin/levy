// Subscribes a wallet to a Levy plan through Permit2 (subscribeWithPermit2),
// for the testnet soak (ops/testnet-soak.md). There is no page for this path.
//
// From the repo root:
//   node keeper/scripts/permit2-subscribe.mjs --plan 1 --ref soak-s5
// Options: --cycles N (allowance to grant, in billing cycles; default 12),
//          --rpc URL, --manager 0x... (default: the Arc testnet deployment).
//
// It asks for the SUBSCRIBER's private key without echoing it, shows what it
// is about to do, and sends nothing until you type "yes". Then:
//   1. if the wallet's USDC allowance to Permit2 is below what that many
//      payments cost (intro payments at the intro price, and no more than a
//      limited plan's payments), it approves Permit2 for exactly that (one
//      transaction);
//   2. it signs a Permit2 PermitSingle naming the Levy manager as spender
//      (off-chain, no gas);
//   3. it submits subscribeWithPermit2 (one transaction), which also charges
//      the first cycle unless the plan has a trial.
import { readFileSync } from "node:fs";
import readline from "node:readline";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseEventLogs,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULTS = {
  rpc: "https://rpc.testnet.arc.io",
  chainId: 5042002,
  manager: "0xea24ac9c1217a671139d93225fdcf19ea3c4df4e",
  usdc: "0x3600000000000000000000000000000000000000",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  explorer: "https://explorer.testnet.arc.io",
};

function args() {
  const out = { cycles: "12" };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined) fail(`bad argument: ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  if (!/^\d+$/.test(out.plan ?? "")) fail("--plan <id> is required (a plan number, e.g. --plan 1)");
  if (!/^\d+$/.test(out.cycles) || +out.cycles < 1 || +out.cycles > 120) fail("--cycles must be 1 to 120");
  if (out.ref !== undefined && !/^[\x20-\x7e]{1,31}$/.test(out.ref)) fail("--ref must be 1 to 31 printable ASCII characters");
  return out;
}

function fail(msg) {
  console.error(`\nSTOPPED: ${msg}\nNothing was sent.`);
  process.exit(1);
}

// One readline for the whole run, read as a queue of lines so typed and piped
// input both work; the key prompt mutes echo while it is read.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted) rl.output.write(s);
};
const lines = rl[Symbol.asyncIterator]();
async function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write("\n");
  if (done) fail("no input");
  return value.trim();
}

const opts = args();
const manager = opts.manager ?? DEFAULTS.manager;
const rpc = opts.rpc ?? DEFAULTS.rpc;
const chain = defineChain({
  id: DEFAULTS.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const transport = http(rpc, { retryCount: 4, retryDelay: 1000 });
const pub = createPublicClient({ chain, transport });

const managerAbi = JSON.parse(readFileSync(new URL("../abi/SubscriptionManager.json", import.meta.url), "utf-8"));
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const usd = (units) => `${formatUnits(units, 6)} USDC`;

const chainId = await pub.getChainId();
if (chainId !== DEFAULTS.chainId) fail(`the RPC is on chain ${chainId}, not Arc testnet (${DEFAULTS.chainId})`);

// Plan: [merchant, price, cycleSeconds, trialSeconds, maxFailed, exists,
//        retired, transferable, maxCycles, introPrice, introCycles]
const [, price, cycleSeconds, trialSeconds, , exists, retired, , maxCycles, introPrice, introCycles] = await pub.readContract({
  address: manager, abi: managerAbi, functionName: "plans", args: [BigInt(opts.plan)],
});
if (!exists) fail(`plan ${opts.plan} does not exist on ${manager}`);
if (retired) fail(`plan ${opts.plan} is retired: it takes no new subscribers`);
// The plan's first payments: intro cycles at the intro price, none past a cycle limit.
const cycles = maxCycles > 0 ? Math.min(+opts.cycles, maxCycles) : +opts.cycles;
const introCount = Math.min(cycles, introCycles);
const amount = introPrice * BigInt(introCount) + price * BigInt(cycles - introCount);
const firstPrice = introCycles > 0 ? introPrice : price;

console.log(`Levy Permit2 subscribe (Arc testnet)`);
console.log(`Plan ${opts.plan}: ${usd(price)} every ${Number(cycleSeconds) / 86400} day(s)` +
  (introCycles > 0 ? `, the first ${introCycles} at ${usd(introPrice)}` : "") +
  (maxCycles > 0 ? `, ${maxCycles} payment(s) in all` : "") +
  (trialSeconds > 0n ? `, ${Number(trialSeconds) / 86400}-day trial` : ", first cycle charged now"));
console.log("");
console.log("Paste the SUBSCRIBER wallet's private key (the 'Private key: 0x...' line). Nothing shows while you paste.");
let key = await ask("Subscriber private key: ", true);
if (key && !key.startsWith("0x")) key = `0x${key}`;
if (/^0x[0-9a-fA-F]{40}$/.test(key)) fail("that was an ADDRESS (40 hex characters), not the private key (64)");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("that is not a private key (expected 0x and 64 hex characters)");
const account = privateKeyToAccount(key);
key = null;
const wallet = createWalletClient({ account, chain, transport });

// Permit2 checks signatures from addresses with code through ERC-1271. Well-known
// test keys on public testnets are often taken over by EIP-7702 sweeper
// delegations, and then the signature is rejected.
const code = await pub.getCode({ address: account.address });
if (code && code !== "0x") {
  fail(`${account.address} has contract code (an EIP-7702 delegation?), so Permit2 will not accept its signature. Use a fresh wallet from 'cast wallet new'.`);
}

const [balance, erc20ToPermit2, p2] = await Promise.all([
  pub.readContract({ address: DEFAULTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  pub.readContract({ address: DEFAULTS.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, DEFAULTS.permit2] }),
  pub.readContract({ address: DEFAULTS.permit2, abi: permit2Abi, functionName: "allowance", args: [account.address, DEFAULTS.usdc, manager] }),
]);
const [, , nonce] = p2;
if (trialSeconds === 0n && balance < firstPrice) fail(`${account.address} holds ${usd(balance)}; the first cycle (${usd(firstPrice)}) is charged now`);

const needApprove = erc20ToPermit2 < amount;
const ref = opts.ref ? stringToHex(opts.ref, { size: 32 }) : `0x${"0".repeat(64)}`;
console.log("");
console.log(`Subscriber:          ${account.address} (${usd(balance)})`);
console.log(`Allowance to grant:  ${usd(amount)} (${cycles} cycles), through Permit2`);
console.log(`Reference:           ${opts.ref ?? "(none)"}`);
console.log(`Transactions:        ${needApprove ? `1) approve Permit2 for ${usd(amount)}, then ` : ""}${needApprove ? "2" : "1"}) subscribeWithPermit2`);
if (await ask('Type "yes" to send: ') !== "yes") fail("not confirmed");

if (needApprove) {
  const hash = await wallet.writeContract({
    address: DEFAULTS.usdc, abi: erc20Abi, functionName: "approve", args: [DEFAULTS.permit2, amount],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") fail(`the Permit2 approval reverted: ${DEFAULTS.explorer}/tx/${hash}`);
  console.log(`Approved Permit2:    ${DEFAULTS.explorer}/tx/${hash}`);
}

const now = BigInt(Math.floor(Date.now() / 1000));
const permitSingle = {
  details: { token: DEFAULTS.usdc, amount, expiration: Number(now + 365n * 86400n), nonce },
  spender: manager,
  sigDeadline: now + 1800n,
};
const signature = await wallet.signTypedData({
  domain: { name: "Permit2", chainId: DEFAULTS.chainId, verifyingContract: DEFAULTS.permit2 },
  types: {
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
  },
  primaryType: "PermitSingle",
  message: permitSingle,
});

const { request } = await pub.simulateContract({
  account, address: manager, abi: managerAbi, functionName: "subscribeWithPermit2",
  args: [BigInt(opts.plan), ref, permitSingle, signature],
});
const hash = await wallet.writeContract(request);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`subscribeWithPermit2 reverted: ${DEFAULTS.explorer}/tx/${hash}`);
const [sub] = parseEventLogs({ abi: managerAbi, logs: receipt.logs, eventName: "Subscribed" });
console.log(`Subscribed:          ${DEFAULTS.explorer}/tx/${hash}`);
console.log(`Subscription ID:     ${sub.args.subId} (record it in ops/testnet-soak.md)`);
rl.close();

// Chain and database half of the daily soak report (ops/testnet-soak.md). It
// runs inside the keeper container, fed on stdin by ops/soak-status.sh, so it
// reads the keeper's own database and uses its RPC settings; the keeper key is
// only used to derive the keeper's address and is never printed.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const manager = env.LEVY_MANAGER_ADDRESS;
const pub = createPublicClient({ transport: http(env.LEVY_RPC_URL, { retryCount: 4, retryDelay: 1000 }) });
const managerAbi = JSON.parse(readFileSync(`${env.LEVY_ABI_DIR ?? "/app/abi"}/SubscriptionManager.json`, "utf-8"));
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const db = new DatabaseSync(env.LEVY_DB_PATH ?? "/data/levy.db", { readOnly: true });

const STATUS = ["TRIAL", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED"];
const usd = (units) => formatUnits(BigInt(units), 6);
const utc = (sec) => new Date(Number(sec) * 1000).toISOString().replace("T", " ").slice(0, 16);
const alerts = [];
const read = (functionName, args = []) => pub.readContract({ address: manager, abi: managerAbi, functionName, args });
const ascii = (hex) => {
  if (!hex) return "";
  const b = Buffer.from(hex.slice(2), "hex");
  const end = b.findLastIndex((x) => x !== 0) + 1;
  const s = b.subarray(0, end).toString("latin1");
  return /^[\x20-\x7e]*$/.test(s) ? s : `${hex.slice(0, 10)}...`;
};
const blockTime = new Map();
async function timeOf(n) {
  if (!blockTime.has(n)) blockTime.set(n, Number((await pub.getBlock({ blockNumber: BigInt(n) })).timestamp));
  return blockTime.get(n);
}

// ---- keeper sync ----
const head = await pub.getBlock();
const now = Number(head.timestamp);
const cursor = BigInt(db.prepare("SELECT value FROM sync_state WHERE key = 'manager_events_from_block'").get()?.value ?? "0");
const lagBlocks = head.number - cursor + 1n;
console.log("== Keeper sync");
console.log(`chain head ${head.number} (${utc(now)} UTC), keeper cursor ${cursor}, behind by ${lagBlocks} blocks`);
if (lagBlocks > 1200n) alerts.push(`keeper is ${lagBlocks} blocks (over 10 minutes) behind the chain`);

// ---- keeper wallet ----
const keeper = privateKeyToAccount(env.LEVY_KEEPER_KEY).address;
const [keeperBal, keeperNonce] = await Promise.all([pub.getBalance({ address: keeper }), pub.getTransactionCount({ address: keeper })]);
console.log("\n== Keeper wallet");
console.log(`${keeper}: ${formatUnits(keeperBal, 18)} USDC, ${keeperNonce} transactions sent`);
if (keeperBal < 10n ** 18n) alerts.push("keeper wallet below 1 USDC");

// ---- subscriptions: database against chain ----
const subs = db.prepare("SELECT * FROM subscriptions ORDER BY CAST(subId AS INTEGER)").all();
console.log("\n== Subscriptions (chain view; * = database disagrees)");
console.log("id  ref         plan status     charges fails next charge (UTC)   credit   last charge late by");
for (const s of subs) {
  const [, planId, , nextChargeAt, failedAttempts, credit, chargeCount, status] = await read("subscriptions", [BigInt(s.subId)]);
  const rows = db.prepare("SELECT * FROM charges WHERE subId = ? ORDER BY chargeCount").all(s.subId);
  const mismatch = Number(chargeCount) !== rows.length || Number(status) !== s.status || Number(nextChargeAt) !== s.nextChargeAt;
  if (mismatch) alerts.push(`sub ${s.subId}: database and chain disagree (charges ${rows.length}/${chargeCount}, status ${s.status}/${status}, next ${s.nextChargeAt}/${nextChargeAt})`);
  let late = "";
  const last = rows.at(-1);
  if (last) {
    // After a charge, nextChargeAt is that charge's billing date plus one cycle
    // (failures do not move it). A resume since then breaks this, so values
    // outside [-1 min, 1 cycle] are shown as n/a.
    const scheduled = Number(nextChargeAt) - s.cycleSeconds;
    const d = (await timeOf(last.blockNumber)) - scheduled;
    late = d < -60 || d > s.cycleSeconds ? "n/a" : `${d}s`;
    if (late !== "n/a" && d > 300) alerts.push(`sub ${s.subId}: last charge ${d}s after its billing date`);
  }
  const chargeable = Number(status) <= 2;
  const dun = db.prepare("SELECT nextRetryAt FROM dunning WHERE subId = ?").get(s.subId);
  const dueAt = dun ? dun.nextRetryAt : Number(nextChargeAt);
  if (chargeable && dueAt < now - 300) alerts.push(`sub ${s.subId}: overdue by ${now - dueAt}s`);
  console.log(
    `${String(s.subId).padEnd(3)} ${ascii(s.ref).padEnd(11)} ${String(planId).padEnd(4)} ${STATUS[Number(status)].padEnd(10)} ` +
      `${String(chargeCount).padStart(7)} ${String(failedAttempts).padStart(5)} ${utc(nextChargeAt).padEnd(19)} ${usd(credit).padStart(8)}   ${late}${mismatch ? " *" : ""}`
  );
}

// ---- money ----
const charges = db.prepare("SELECT * FROM charges").all();
const recentFrom = head.number - 172_800n; // about 24 h at 0.5 s blocks
const recent = charges.filter((c) => BigInt(c.blockNumber) >= recentFrom);
let pulled = 0n, fees = 0n, badFees = 0;
for (const c of charges) {
  pulled += BigInt(c.amount);
  fees += BigInt(c.fee);
  if (BigInt(c.fee) !== BigInt(c.amount) / 100n) badFees++;
}
if (badFees) alerts.push(`${badFees} charges break fee = floor(amount / 100)`);
const feeRouter = await read("feeRouter");
const routerBal = await pub.readContract({ address: env.LEVY_USDC_ADDRESS, abi: erc20, functionName: "balanceOf", args: [feeRouter] });
console.log("\n== Money");
console.log(`charges: ${charges.length} all time, ${recent.length} in the last 24 h; pulled ${usd(pulled)} USDC, fees ${usd(fees)} USDC, fee rule broken ${badFees} times`);
console.log(`fee router holds ${usd(routerBal)} USDC; fees recorded ${usd(fees)} USDC${routerBal === fees ? " (equal)" : " (differ: expected after a sweep)"}`);
const fails = db.prepare("SELECT subId, COUNT(*) n, MAX(failedAttempts) maxAttempts FROM charge_failures GROUP BY subId").all();
console.log(`failed charges: ${fails.map((f) => `sub ${f.subId} x${f.n}`).join(", ") || "none"}`);
const dunning = db.prepare("SELECT * FROM dunning").all();
console.log(`dunning queue: ${dunning.map((d) => `sub ${d.subId} attempt ${d.attempts}, retry ${utc(d.nextRetryAt)}`).join("; ") || "empty"}`);
const low = db.prepare("SELECT * FROM subscriber_funds WHERE low = 1").all();
console.log(`allowance low: ${low.map((f) => `${f.subscriber.slice(0, 8)} covers ${f.cycles_covered}`).join(", ") || "none"}`);

// ---- webhooks, as the keeper saw them ----
const deliveries = db.prepare("SELECT status, COUNT(*) n FROM webhook_deliveries GROUP BY status").all();
const byEvent = db.prepare("SELECT event_type, COUNT(*) n FROM webhook_deliveries WHERE status = 'sent' GROUP BY event_type").all();
const dead = db.prepare("SELECT id, event_type, last_error FROM webhook_deliveries WHERE status = 'dead'").all();
console.log("\n== Webhook deliveries (keeper)");
console.log(`endpoints: ${db.prepare("SELECT COUNT(*) n FROM webhooks WHERE active = 1").get().n} active`);
console.log(`by status: ${deliveries.map((d) => `${d.status} ${d.n}`).join(", ") || "none yet"}`);
console.log(`sent by event: ${byEvent.map((e) => `${e.event_type} ${e.n}`).join(", ") || "none yet"}`);
for (const d of dead) alerts.push(`delivery ${d.id} (${d.event_type}) dead: ${d.last_error}`);

console.log("\n== Alerts");
console.log(alerts.length ? alerts.map((a) => `! ${a}`).join("\n") : "none");

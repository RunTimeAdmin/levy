import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClients } from "../src/chain.js";
import { LevyDb } from "../src/db.js";
import { Keeper } from "../src/keeper.js";

const ABI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "abi");
const abi = (n: string) => JSON.parse(readFileSync(join(ABI_DIR, `${n}.json`), "utf-8"));
const bin = (n: string) => readFileSync(join(ABI_DIR, `${n}.bin`), "utf-8").trim() as `0x${string}`;

const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;

const PRICE = 10_000_000n; // $10.00
const CYCLE = 30 * 86_400;

let anvil: ChildProcess;
let keeper: ReturnType<typeof privateKeyToAccount>;
let alice: ReturnType<typeof privateKeyToAccount>;
let bob: ReturnType<typeof privateKeyToAccount>;
let carol: ReturnType<typeof privateKeyToAccount>;
let merchant: ReturnType<typeof privateKeyToAccount>;
let publicClient: any;
let usdc: any;
let manager: any;
let feeRouterAddr: string;
let db: LevyDb;
let keeperSvc: Keeper;

async function mine() {
  await publicClient.request({ method: "evm_mine", params: [] } as any);
}

/** Send a write and wait until it is mined, so later evm_increaseTime calls
 *  cannot retroactively shift the tx's block timestamp. */
async function mined(hash: `0x${string}`) {
  await publicClient.waitForTransactionReceipt({ hash });
}

async function increaseTime(sec: number) {
  await publicClient.request({ method: "evm_increaseTime", params: [sec] } as any);
  await mine();
}

// Chain-head timestamp. The keeper operates on chain time, and these tests
// warp chain time independently of the wall clock.
async function chainTime(): Promise<number> {
  return Number((await publicClient.getBlock()).timestamp);
}

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await publicClient.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil did not start");
}

before(async () => {
  // Start anvil and harvest its printed private keys (guaranteed correct).
  let out = "";
  const keyPromise = new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("anvil keys not printed")), 15000);
    const check = () => {
      const keys = [...out.matchAll(/^\(\d+\)\s+(0x[0-9a-f]{64})/gm)].map((m) => m[1]);
      if (keys.length >= 4) {
        clearTimeout(timer);
        resolve(keys);
      }
    };
    anvil = spawn("anvil", ["--port", String(PORT)], {
      env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    anvil.stdout!.on("data", (d: Buffer) => { out += d.toString(); check(); });
    anvil.stderr!.on("data", (d: Buffer) => { out += d.toString(); check(); });
    anvil.on("error", reject);
  });
  const keys = await keyPromise;
  const KEEPER_KEY = keys[0] as `0x${string}`;
  const ALICE_KEY = keys[1] as `0x${string}`;
  const BOB_KEY = keys[2] as `0x${string}`;
  const CAROL_KEY = keys[3] as `0x${string}`;

  keeper = privateKeyToAccount(KEEPER_KEY as `0x${string}`);
  alice = privateKeyToAccount(ALICE_KEY as `0x${string}`);
  bob = privateKeyToAccount(BOB_KEY as `0x${string}`);
  carol = privateKeyToAccount(CAROL_KEY);
  merchant = keeper; // keeper account doubles as merchant deployer

  const chain = {
    id: CHAIN_ID,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const;
  const transport = http(RPC);
  publicClient = createPublicClient({ chain, transport });
  await waitForAnvil();

  const wallet = (key: `0x${string}`) =>
    createWalletClient({ account: privateKeyToAccount(key), chain, transport });

  const deployer = wallet(KEEPER_KEY as `0x${string}`);
  const deploy = async (name: string, args: any[] = []) => {
    const hash = await deployer.deployContract({
      abi: abi(name), bytecode: bin(name), args, chain, account: keeper,
    } as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress as string;
  };

  const usdcAddr = await deploy("MockUSDC");
  feeRouterAddr = await deploy("FeeRouter", [usdcAddr, keeper.address]);
  const permit2Addr = await deploy("MockPermit2");
  const managerAddr = await deploy("SubscriptionManager", [usdcAddr, feeRouterAddr, permit2Addr]);

  const erc20 = parseAbi([
    "function mint(address to, uint256 amount)",
    "function approve(address spender, uint256 amount)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  usdc = getContract({ address: usdcAddr as `0x${string}`, abi: erc20, client: { public: publicClient, wallet: deployer } });
  manager = getContract({
    address: managerAddr as `0x${string}`, abi: abi("SubscriptionManager"),
    client: { public: publicClient, wallet: deployer },
  });

  // Fund subscribers with USDC.
  for (const a of [alice.address, bob.address]) {
    await usdc.write.mint([a, 1_000_000_000n], { account: keeper, chain });
  }

  // Merchant creates a $10 / 30-day plan (maxFailed = 2).
  await manager.write.createPlan([PRICE, CYCLE, 0, 3 * 86_400, 2], { account: keeper, chain });

  // Keeper service under test.
  process.env.LEVY_RPC_URL = RPC;
  process.env.LEVY_CHAIN_ID = String(CHAIN_ID);
  process.env.LEVY_MANAGER_ADDRESS = managerAddr;
  process.env.LEVY_USDC_ADDRESS = usdcAddr;
  process.env.LEVY_KEEPER_KEY = KEEPER_KEY;
  process.env.LEVY_DB_PATH = ":memory:";
  process.env.LEVY_LOOKBACK_BLOCKS = "100000"; // anvil: scan from genesis
  process.env.LEVY_WEBHOOK_ALLOW_PRIVATE = "1"; // webhooks below point at local servers
  // Tiny getLogs chunks, so every sync in this suite crosses many chunk
  // boundaries (production default is 500).
  process.env.LEVY_LOG_CHUNK_BLOCKS = "7";
  process.env.LEVY_WEBHOOK_KEY_PATH = join(dirname(fileURLToPath(import.meta.url)), "test-webhook-key.pem");

  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig();
  const clients = createClients({ ...cfg, chainId: CHAIN_ID });
  db = new LevyDb(":memory:");
  keeperSvc = new Keeper(cfg, clients as any, db);
});

after(() => {
  db?.close();
  anvil?.kill("SIGKILL");
  try { rmSync(join(dirname(fileURLToPath(import.meta.url)), "test-webhook-key.pem")); } catch { /* ignore */ }
});

describe("keeper integration (anvil)", () => {
  it("charges a due subscription and splits 99/1", async () => {
    // Alice subscribes and approves.
    const aliceWallet = createWalletClient({
      account: alice, chain: publicClient.chain, transport: http(RPC),
    });
    const asAlice = getContract({
      address: manager.address, abi: abi("SubscriptionManager"),
      client: { public: publicClient, wallet: aliceWallet },
    });
    const asAliceUsdc = getContract({
      address: usdc.address, abi: usdc.abi,
      client: { public: publicClient, wallet: aliceWallet },
    });
    await asAliceUsdc.write.approve([manager.address, PRICE * 12n], { account: alice, chain: publicClient.chain });
    await mined(await asAlice.write.subscribe([1n], { account: alice, chain: publicClient.chain }));

    await increaseTime(CYCLE + 60);

    const mBefore = await usdc.read.balanceOf([keeper.address]);
    const report = await keeperSvc.runCycle();

    assert.equal(report.charged.length, 1);
    assert.equal(report.charged[0].subId, "1");

    const mAfter = await usdc.read.balanceOf([keeper.address]);
    assert.equal(mAfter - mBefore, PRICE - PRICE / 100n); // merchant (keeper acct) gets 99%
    const feeBal = await usdc.read.balanceOf([feeRouterAddr]);
    assert.equal(feeBal, 2n * (PRICE / 100n)); // 1% to the router, for subscribe + this charge

    // DB recorded the charge with an invoice reference.
    const row = db["db"].prepare("SELECT * FROM charges WHERE subId = '1'").get() as any;
    assert.ok(row);
    assert.equal(row.amount, PRICE.toString());
    assert.ok(/^0x[0-9a-f]{64}$/.test(row.invoiceRef));
    // No dunning for a successful charge.
    assert.equal(db.dueRetries((await chainTime()) + 365 * 86_400).length, 0);
  });

  it("records failures and schedules dunning retries", async () => {
    // Bob approves exactly one cycle, which subscribe spends up front: every
    // later pull fails.
    const bobWallet = createWalletClient({
      account: bob, chain: publicClient.chain, transport: http(RPC),
    });
    const asBob = getContract({
      address: manager.address, abi: abi("SubscriptionManager"),
      client: { public: publicClient, wallet: bobWallet },
    });
    const asBobUsdc = getContract({
      address: usdc.address, abi: usdc.abi,
      client: { public: publicClient, wallet: bobWallet },
    });
    await mined(await asBobUsdc.write.approve([manager.address, PRICE], { account: bob, chain: publicClient.chain }));
    await mined(await asBob.write.subscribe([1n], { account: bob, chain: publicClient.chain }));
    await increaseTime(CYCLE + 60);

    const report = await keeperSvc.runCycle();
    // Alice's sub charges again; Bob's pull fails but must not revert the cycle.
    assert.ok(report.charged.some((c) => c.subId === "1"));

    const failures = db["db"].prepare("SELECT * FROM charge_failures WHERE subId = '2'").all();
    assert.ok(failures.length >= 1);

    // Dunning row exists with the retry ~1 day out (chain time).
    const nowSec = await chainTime();
    const rows = db["db"].prepare("SELECT * FROM dunning WHERE subId = '2'").all() as any[];
    assert.equal(rows.length, 1);
    assert.ok(rows[0].nextRetryAt > nowSec);
    assert.ok(rows[0].nextRetryAt <= nowSec + 86_400 + 120);
    // Not due yet at chain now, due after the 1-day backoff.
    assert.equal(db.dueRetries(nowSec).length, 0);
    assert.equal(db.dueRetries(nowSec + 86_400 + 1).filter((r) => r.subId === "2").length, 1);
  });

  it("retries after the backoff and clears dunning on success", async () => {
    // Bob approves now; warp past the 1-day retry; keeper should collect.
    const bobWallet = createWalletClient({
      account: bob, chain: publicClient.chain, transport: http(RPC),
    });
    const asBobUsdc = getContract({
      address: usdc.address, abi: usdc.abi,
      client: { public: publicClient, wallet: bobWallet },
    });
    await asBobUsdc.write.approve([manager.address, PRICE * 12n], { account: bob, chain: publicClient.chain });

    await increaseTime(86_400 + 120);
    const report = await keeperSvc.runCycle();
    assert.ok(report.retried.some((c) => c.subId === "2"), "expected sub 2 in retried");

    const rows = db["db"].prepare("SELECT * FROM dunning WHERE subId = '2'").all();
    assert.equal(rows.length, 0); // cleared on success
  });

  it("resume clears dunning and charges from now", async () => {
    // Bob's allowance lapses, his next charge fails and dunning schedules a
    // retry a day out. He pauses, then resumes right away with a new allowance.
    const bobWallet = createWalletClient({
      account: bob, chain: publicClient.chain, transport: http(RPC),
    });
    const asBob = getContract({
      address: manager.address, abi: abi("SubscriptionManager"),
      client: { public: publicClient, wallet: bobWallet },
    });
    const asBobUsdc = getContract({
      address: usdc.address, abi: usdc.abi,
      client: { public: publicClient, wallet: bobWallet },
    });
    await mined(await asBobUsdc.write.approve([manager.address, 0n], { account: bob, chain: publicClient.chain }));
    await increaseTime(CYCLE + 60);
    const failing = await keeperSvc.runCycle();
    assert.ok(failing.failed.some((f) => f.subId === "2"), "expected sub 2 to fail");
    assert.equal(db["db"].prepare("SELECT * FROM dunning WHERE subId = '2'").all().length, 1);

    await mined(await asBob.write.pauseSubscription([2n], { account: bob, chain: publicClient.chain }));
    await mined(await asBob.write.resumeSubscription([2n], { account: bob, chain: publicClient.chain }));
    await mined(await asBobUsdc.write.approve([manager.address, PRICE * 12n], { account: bob, chain: publicClient.chain }));

    // The retry is not due for a day, but the resumed sub is charged now.
    const report = await keeperSvc.runCycle();
    assert.equal(report.charged.filter((c) => c.subId === "2").length, 1);
    assert.equal(db["db"].prepare("SELECT * FROM dunning WHERE subId = '2'").all().length, 0);
  });

  it("enqueues webhook events on Subscribed and Charged", async () => {
    // Merchant (keeper account) registers for the billing events. The URL is
    // unreachable on purpose: this test asserts enqueueing, not delivery.
    keeperSvc.webhooks.register(
      keeper.address,
      "http://127.0.0.1:9/unused",
      ["subscription.created", "charge.succeeded", "charge.failed", "dunning.started", "invoice.ready"],
      await chainTime()
    );

    // Alice opens a second subscription, then it comes due and charges.
    const aliceWallet = createWalletClient({
      account: alice, chain: publicClient.chain, transport: http(RPC),
    });
    const asAlice = getContract({
      address: manager.address, abi: abi("SubscriptionManager"),
      client: { public: publicClient, wallet: aliceWallet },
    });
    await mined(await asAlice.write.subscribe([1n], { account: alice, chain: publicClient.chain }));
    await increaseTime(CYCLE + 60);
    const report = await keeperSvc.runCycle();
    assert.ok(report.charged.some((c) => c.subId === "3"), "expected sub 3 charged");

    const deliveries = db["db"]
      .prepare("SELECT event_type, status FROM webhook_deliveries ORDER BY id ASC")
      .all() as Array<{ event_type: string; status: string }>;
    const types = deliveries.map((d) => d.event_type);
    assert.ok(types.includes("subscription.created"), `missing subscription.created in ${types}`);
    assert.ok(types.includes("charge.succeeded"), `missing charge.succeeded in ${types}`);
    assert.ok(types.includes("invoice.ready"), `missing invoice.ready in ${types}`);
    // Payloads are canonical JSON carrying the merchant.
    const created = db["db"]
      .prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'subscription.created'")
      .get() as { payload: string };
    const payload = JSON.parse(created.payload);
    assert.equal(payload.subId, "3");
    assert.equal(payload.merchant.toLowerCase(), keeper.address.toLowerCase());
  });
  it("charging never waits on webhook delivery", async () => {
    // An endpoint that accepts connections and never answers. Before delivery
    // moved to its own loop, runCycle POSTed to it and stalled all charging.
    const hits: string[] = [];
    const hang = createServer((req) => { hits.push(req.url ?? ""); });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const hangPort = (hang.address() as { port: number }).port;
    try {
      const hookId = keeperSvc.webhooks.register(
        keeper.address,
        `http://127.0.0.1:${hangPort}/hang`,
        ["subscription.created", "charge.succeeded", "invoice.ready"],
        await chainTime()
      );
      const aliceWallet = createWalletClient({
        account: alice, chain: publicClient.chain, transport: http(RPC),
      });
      const asAlice = getContract({
        address: manager.address, abi: abi("SubscriptionManager"),
        client: { public: publicClient, wallet: aliceWallet },
      });
      const asAliceUsdc = getContract({
        address: usdc.address, abi: usdc.abi,
        client: { public: publicClient, wallet: aliceWallet },
      });
      await mined(await asAliceUsdc.write.approve([manager.address, PRICE * 100n], { account: alice, chain: publicClient.chain }));
      await mined(await asAlice.write.subscribe([1n], { account: alice, chain: publicClient.chain }));
      await increaseTime(CYCLE + 60);

      const report = await keeperSvc.runCycle();
      assert.ok(report.charged.some((c) => c.subId === "4"), "expected sub 4 charged");
      assert.equal(hits.length, 0, "runCycle must not deliver webhooks");
      const rows = db["db"]
        .prepare("SELECT status FROM webhook_deliveries WHERE webhook_id = ?")
        .all(hookId) as Array<{ status: string }>;
      assert.ok(rows.length >= 3, `expected queued deliveries, got ${rows.length}`);
      assert.ok(rows.every((r) => r.status === "pending"));
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });

  it("indexes plans nobody subscribed to, and reports plan changes", async () => {
    keeperSvc.webhooks.register(keeper.address, "http://127.0.0.1:9/updates", ["subscription.updated"], await chainTime());
    // Plan 2: same merchant, twice the price, no subscribers yet.
    await mined(await manager.write.createPlan([PRICE * 2n, CYCLE, 0, 3 * 86_400, 2], { account: keeper, chain: publicClient.chain }));
    await keeperSvc.runCycle();
    const plan2 = db.listPlans().find((p) => p.planId === "2");
    assert.ok(plan2, "plan 2 indexed without subscribers");
    assert.equal(plan2.price, (PRICE * 2n).toString());
    assert.equal(plan2.merchant.toLowerCase(), keeper.address.toLowerCase());

    // Alice moves sub 4 to plan 2: the merchant gets subscription.updated.
    const aliceWallet = createWalletClient({
      account: alice, chain: publicClient.chain, transport: http(RPC),
    });
    const asAlice = getContract({
      address: manager.address, abi: abi("SubscriptionManager"),
      client: { public: publicClient, wallet: aliceWallet },
    });
    await mined(await asAlice.write.changePlan([4n, 2n], { account: alice, chain: publicClient.chain }));
    await keeperSvc.runCycle();
    const row = db["db"]
      .prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'subscription.updated'")
      .get() as { payload: string } | undefined;
    assert.ok(row, "subscription.updated enqueued");
    const payload = JSON.parse(row.payload);
    assert.equal(payload.subId, "4");
    assert.equal(payload.oldPlanId, "1");
    assert.equal(payload.newPlanId, "2");
  });

  it("backs off a charge that reverts instead of retrying every cycle", async () => {
    // A row the chain does not know: charge() reverts (UnknownSubscription).
    db.upsertSubscription({
      subId: "999", subscriber: alice.address, planId: "1", merchant: keeper.address,
      price: PRICE.toString(), cycleSeconds: CYCLE, status: 1, nextChargeAt: 0, failedAttempts: 0,
    });
    const attempted = (r: { failed: Array<{ subId: string }> }) => r.failed.some((f) => f.subId === "999");
    assert.ok(attempted(await keeperSvc.runCycle()), "first attempt");
    assert.ok(!attempted(await keeperSvc.runCycle()), "skipped inside the 1m backoff");
    await increaseTime(61);
    assert.ok(attempted(await keeperSvc.runCycle()), "retried after the backoff");
    assert.ok(!attempted(await keeperSvc.runCycle()), "now backing off 5m");
  });

  it("warns the merchant once when a subscriber's allowance runs low", async () => {
    keeperSvc.webhooks.register(keeper.address, "http://127.0.0.1:9/funds", ["allowance.low"], await chainTime());
    await mined(await usdc.write.mint([carol.address, 1_000_000_000n], { account: keeper, chain: publicClient.chain }));
    const carolWallet = createWalletClient({ account: carol, chain: publicClient.chain, transport: http(RPC) });
    const asCarol = getContract({
      address: manager.address, abi: abi("SubscriptionManager"),
      client: { public: publicClient, wallet: carolWallet },
    });
    const asCarolUsdc = getContract({
      address: usdc.address, abi: usdc.abi,
      client: { public: publicClient, wallet: carolWallet },
    });
    const warnings = () => (db["db"]
      .prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'allowance.low'")
      .all() as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload))
      .filter((p) => p.subscriber.toLowerCase() === carol.address.toLowerCase());

    // Two cycles approved; subscribing spends one, leaving one: under the
    // two-cycle warning level.
    await mined(await asCarolUsdc.write.approve([manager.address, PRICE * 2n], { account: carol, chain: publicClient.chain }));
    await mined(await asCarol.write.subscribe([1n], { account: carol, chain: publicClient.chain }));
    await keeperSvc.runCycle();
    assert.equal(db.getFunds(carol.address)?.low, 1);
    assert.equal(db.getFunds(carol.address)?.cycles_covered, 1);
    assert.equal(warnings().length, 1);
    assert.equal(warnings()[0].cyclesCovered, 1);
    assert.equal(warnings()[0].allowance, PRICE.toString());

    // Still low at the next check: no second warning.
    db.markFundsStale(carol.address);
    await keeperSvc.runCycle();
    assert.equal(warnings().length, 1);

    // A top-up (an Approval to the manager) triggers a recheck and clears it.
    await mined(await asCarolUsdc.write.approve([manager.address, PRICE * 12n], { account: carol, chain: publicClient.chain }));
    await keeperSvc.runCycle();
    assert.equal(db.getFunds(carol.address)?.low, 0);
    assert.equal(db.getFunds(carol.address)?.cycles_covered, 12);
  });
});

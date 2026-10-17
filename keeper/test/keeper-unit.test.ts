import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  parseAbiItem,
  toEventSelector,
  type AbiEvent,
} from "viem";
import { managerAbi } from "../src/chain.js";
import type { ChainClients } from "../src/chain.js";
import type { LevyConfig } from "../src/config.js";
import { LevyDb, Status } from "../src/db.js";
import { DAY_SECONDS } from "../src/dunning.js";
import { Indexer } from "../src/indexer.js";
import { Keeper } from "../src/keeper.js";

// Unit tests for log scanning (Indexer.sync) and the keeper's charge and retry
// loop, against an in-memory fake chain. The anvil integration test covers the
// happy paths end to end; these pin down chunking, ordering, the sync cursor
// on failure, and the error backoff schedule, which a real node cannot easily
// be made to exercise.

const MANAGER = "0x00000000000000000000000000000000000000aa" as const;
const USDC = "0x00000000000000000000000000000000000000bb" as const;
const ALICE = "0x00000000000000000000000000000000000a11ce";
const MERCHANT = "0x000000000000000000000000000000000000beef";
const OTHER = "0x0000000000000000000000000000000000000123";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_REF = `0x${"0".repeat(64)}`;
const T0 = 1_700_000_000;
const PRICE = 10_000_000n;
const CYCLE = 30 * DAY_SECONDS;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const APPROVAL = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");

interface Log {
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

function cfg(over: Partial<LevyConfig> = {}): LevyConfig {
  return {
    rpcUrl: "http://unused",
    chainId: 31337,
    managerAddress: MANAGER,
    usdcAddress: USDC,
    keeperKey: `0x${"1".repeat(64)}`,
    pollIntervalMs: 1000,
    dunningScheduleDays: [1, 3, 7],
    dbPath: ":memory:",
    initialLookbackBlocks: 5000,
    logChunkBlocks: 500,
    webhookKeyPath: "/nonexistent",
    webhookKey: Buffer.alloc(32, 7).toString("base64"),
    webhookAllowPrivate: true,
    webhookPollMs: 1000,
    ...over,
  };
}

function managerEvent(name: string, args: Record<string, unknown>): { topics: `0x${string}`[]; data: `0x${string}` } {
  const ev = (managerAbi as AbiEvent[]).find((e) => e.type === "event" && e.name === name)!;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as any) as `0x${string}`[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]));
  return { topics, data };
}

function erc20Event(ev: AbiEvent, a: string, b: string, value: bigint) {
  return {
    topics: [toEventSelector(ev), pad(a as `0x${string}`), pad(b as `0x${string}`)] as `0x${string}`[],
    data: pad(`0x${value.toString(16)}` as `0x${string}`),
  };
}

type Receipt = { status: "success" | "reverted"; logs: Log[] };
type ChargeResult = { revert: true } | { throws: Error } | { events: Array<{ address?: string; name: string; args: Record<string, unknown> }> };

/** Just enough of viem's public client and the manager contract for the keeper. */
class FakeChain {
  head = 100n;
  time = T0;
  logs: Log[] = [];
  getLogsCalls: Array<{ address: string; fromBlock: bigint; toBlock: bigint }> = [];
  /** Throw from getLogs for a chunk starting at this block (once). */
  failChunkAt?: bigint;
  /** Ignore `args` filters, like a lax RPC, so the indexer's own checks run. */
  laxArgs = false;
  /** Reverse each getLogs batch, so ordering is the indexer's job. */
  reverseBatches = false;
  subs = new Map<string, any[]>();
  plans = new Map<string, any[]>();
  refs = new Map<string, string>();
  chargeCalls: string[] = [];
  chargeResults: ChargeResult[] = [];
  receipts = new Map<string, Receipt>();
  allowance = new Map<string, bigint>();
  readFails = false;
  private txCounter = 0;

  addLog(address: string, e: { topics: `0x${string}`[]; data: `0x${string}` }, block = this.head): Log {
    const log: Log = {
      address,
      ...e,
      blockNumber: block,
      transactionHash: `0x${(++this.txCounter).toString(16).padStart(64, "0")}`,
      logIndex: this.logs.filter((l) => l.blockNumber === block).length,
    };
    this.logs.push(log);
    return log;
  }

  setPlan(planId: number, price = PRICE, merchant = MERCHANT) {
    this.plans.set(String(planId), [merchant, price, BigInt(CYCLE), 0n, 0n, 2, true]);
  }

  setSub(subId: number, o: { planId?: number; status?: number; next?: number; failed?: number; subscriber?: string } = {}) {
    this.subs.set(String(subId), [
      o.subscriber ?? ALICE,
      BigInt(o.planId ?? 1),
      BigInt(T0 - CYCLE),
      BigInt(o.next ?? T0),
      BigInt(o.failed ?? 0),
      0n,
      1n,
      o.status ?? Status.ACTIVE,
    ]);
  }

  clients(): ChainClients {
    const self = this;
    const pub = {
      async getBlock() {
        return { number: self.head, timestamp: BigInt(self.time) };
      },
      async getLogs(p: { address: string; event?: AbiEvent; args?: Record<string, string>; fromBlock: bigint; toBlock: bigint }) {
        self.getLogsCalls.push({ address: p.address, fromBlock: p.fromBlock, toBlock: p.toBlock });
        if (self.failChunkAt !== undefined && p.fromBlock === self.failChunkAt) {
          self.failChunkAt = undefined;
          throw new Error("rate limit exceeded");
        }
        const out = self.logs.filter((l) => {
          if (l.address !== p.address || l.blockNumber < p.fromBlock || l.blockNumber > p.toBlock) return false;
          if (!p.event) return true;
          if (l.topics[0] !== toEventSelector(p.event)) return false;
          if (self.laxArgs || !p.args) return true;
          const indexed = p.event.inputs.filter((i) => i.indexed);
          return Object.entries(p.args).every(([k, v]) => {
            const pos = indexed.findIndex((i) => i.name === k) + 1;
            return BigInt(l.topics[pos]) === BigInt(v);
          });
        });
        return self.reverseBatches ? out.reverse() : out;
      },
      async waitForTransactionReceipt({ hash }: { hash: string }) {
        return self.receipts.get(hash)!;
      },
      async readContract({ functionName, args }: { functionName: string; args: string[] }) {
        if (self.readFails) throw new Error("rpc down");
        if (functionName === "allowance") return self.allowance.get(args[0]) ?? 0n;
        return 10n ** 12n;
      },
    };
    const manager = {
      read: {
        subscriptions: async ([id]: [bigint]) =>
          self.subs.get(id.toString()) ?? [ZERO, 0n, 0n, 0n, 0n, 0n, 0n, 0],
        plans: async ([id]: [bigint]) => self.plans.get(id.toString()) ?? [ZERO, 0n, 0n, 0n, 0n, 0, false],
        subscriptionRef: async ([id]: [bigint]) => self.refs.get(id.toString()) ?? ZERO_REF,
        planCount: async () => BigInt(self.plans.size),
        subCount: async () => BigInt(self.subs.size),
      },
      write: {
        charge: async ([id]: [bigint]) => {
          const subId = id.toString();
          self.chargeCalls.push(subId);
          const r = self.chargeResults.shift() ?? { events: [{ name: "Charged", args: chargedArgs(subId) }] };
          if ("throws" in r) throw r.throws;
          self.head += 1n;
          const hash = `0xc${(++self.txCounter).toString(16).padStart(63, "0")}`;
          if ("revert" in r) {
            self.receipts.set(hash, { status: "reverted", logs: [] });
            return hash;
          }
          const logs = r.events.map((e) => self.addLog(e.address ?? MANAGER, managerEvent(e.name, e.args)));
          self.receipts.set(hash, { status: "success", logs });
          return hash;
        },
      },
    };
    return { public: pub as any, wallet: {} as any, account: {} as any, manager, chain: {} as any };
  }
}

function chargedArgs(subId: string, chargeCount = 2n) {
  return { subId: BigInt(subId), amount: PRICE, fee: PRICE / 100n, invoiceRef: `0x${"ab".repeat(32)}`, chargeCount };
}

function setup(over: Partial<LevyConfig> = {}) {
  const chain = new FakeChain();
  const db = new LevyDb(":memory:");
  const c = cfg(over);
  const events: Array<{ type: string; merchant: string; payload: any }> = [];
  const indexer = new Indexer(c, chain.clients(), db, (type, merchant, payload) => events.push({ type, merchant, payload }));
  return { chain, db, c, indexer, events };
}

describe("Indexer.sync: log scanning", () => {
  it("starts initialLookbackBlocks back on first run and scans in chunks", async () => {
    const { chain, db, indexer } = setup({ initialLookbackBlocks: 1000, logChunkBlocks: 400 });
    chain.head = 5000n;
    const r = await indexer.sync();
    assert.equal(r.fromBlock, 4000n);
    assert.equal(r.toBlock, 5000n);
    assert.equal(r.nowSec, T0);
    const managerCalls = chain.getLogsCalls.filter((c) => c.address === MANAGER);
    assert.deepEqual(managerCalls.map((c) => [c.fromBlock, c.toBlock]), [[4000n, 4399n], [4400n, 4799n], [4800n, 5000n]]);
    // Four queries per chunk: manager events, Transfers in, Transfers out, Approvals.
    assert.equal(chain.getLogsCalls.length, 12);
    assert.equal(db.getSync("manager_events_from_block"), "5001");
    db.close();
  });

  it("starts at block 0 when the chain is younger than the lookback", async () => {
    const { chain, db, indexer } = setup({ initialLookbackBlocks: 1000 });
    chain.head = 10n;
    const r = await indexer.sync();
    assert.equal(r.fromBlock, 0n);
    db.close();
  });

  it("resumes from the stored cursor and does nothing when caught up", async () => {
    const { chain, db, indexer } = setup();
    await indexer.sync();
    chain.getLogsCalls = [];
    const r = await indexer.sync(); // head unchanged: cursor is head + 1
    assert.equal(r.logs, 0);
    assert.equal(chain.getLogsCalls.length, 0);

    chain.head = 105n;
    const r2 = await indexer.sync();
    assert.equal(r2.fromBlock, 101n);
    assert.deepEqual(chain.getLogsCalls.map((c) => [c.fromBlock, c.toBlock])[0], [101n, 105n]);
    db.close();
  });

  it("keeps the cursor after the last good chunk when a chunk fails", async () => {
    const { chain, db, indexer } = setup({ initialLookbackBlocks: 1000, logChunkBlocks: 400 });
    chain.head = 5000n;
    chain.setPlan(1);
    chain.setSub(1);
    chain.addLog(MANAGER, managerEvent("ChargeFailed", { subId: 1n, failedAttempts: 1n }), 4100n);
    chain.failChunkAt = 4400n;
    await assert.rejects(indexer.sync(), /rate limit/);
    assert.equal(db.getSync("manager_events_from_block"), "4400");
    assert.equal(db.getDunning("1")?.attempts, 1);

    // The next sync re-reads only from the failed chunk on: the first chunk's
    // failure is not recorded twice.
    chain.getLogsCalls = [];
    await indexer.sync();
    assert.equal(chain.getLogsCalls[0].fromBlock, 4400n);
    assert.equal(db.getSync("manager_events_from_block"), "5001");
    db.close();
  });

  it("handles logs in chain order whatever order the queries return them", async () => {
    const { chain, db, indexer } = setup();
    chain.reverseBatches = true;
    chain.setPlan(1);
    chain.setSub(1);
    // A failure, then a successful retry: in chain order dunning ends cleared.
    chain.addLog(MANAGER, managerEvent("ChargeFailed", { subId: 1n, failedAttempts: 1n }), 90n);
    chain.addLog(MANAGER, managerEvent("Charged", chargedArgs("1")), 95n);
    await indexer.sync();
    assert.equal(db.getDunning("1"), undefined);
    assert.equal(db.listCharges({ subId: "1" }).length, 1);
    db.close();
  });

  it("orders logs in one block by logIndex", async () => {
    const { chain, db, indexer } = setup();
    chain.reverseBatches = true;
    chain.setPlan(1);
    chain.setSub(1);
    chain.addLog(MANAGER, managerEvent("Charged", chargedArgs("1")), 90n); // logIndex 0
    chain.addLog(MANAGER, managerEvent("ChargeFailed", { subId: 1n, failedAttempts: 1n }), 90n); // logIndex 1
    await indexer.sync();
    assert.equal(db.getDunning("1")?.attempts, 1);
    db.close();
  });

  it("records ChargeFailed with chain time and schedules the retry", async () => {
    const { chain, db, indexer, events } = setup();
    chain.setPlan(1);
    chain.setSub(1, { status: Status.PAST_DUE, failed: 2 });
    chain.addLog(MANAGER, managerEvent("ChargeFailed", { subId: 1n, failedAttempts: 2n }), 99n);
    await indexer.sync();
    const d = db.getDunning("1")!;
    assert.equal(d.attempts, 2);
    assert.equal(d.nextRetryAt, T0 + 3 * DAY_SECONDS);
    assert.equal(db.getSubscription("1")?.status, Status.PAST_DUE);
    assert.equal(db.chargeStats().failures, 1);
    assert.ok(events.some((e) => e.merchant === MERCHANT && e.payload.subId === "1"));
    db.close();
  });

  it("Charged records the charge, clears dunning and marks funds stale", async () => {
    const { chain, db, indexer } = setup();
    chain.setPlan(1);
    chain.setSub(1);
    db.setDunning({ subId: "1", attempts: 1, nextRetryAt: T0 + 1, updatedAt: T0 });
    db.upsertFunds({ subscriber: ALICE, allowance: "0", balance: "0", per_cycle: "0", cycles_covered: 0, low: 1, checked_at: T0 });
    chain.addLog(MANAGER, managerEvent("Charged", chargedArgs("1", 5n)), 99n);
    await indexer.sync();
    const [charge] = db.listCharges({ subId: "1" });
    assert.equal(charge.amount, PRICE.toString());
    assert.equal(charge.fee, (PRICE / 100n).toString());
    assert.equal(charge.chargeCount, 5);
    assert.equal(db.getDunning("1"), undefined);
    assert.equal(db.getFunds(ALICE)?.checked_at, 0);
    db.close();
  });

  it("Resumed clears a stale dunning row", async () => {
    const { chain, db, indexer } = setup();
    chain.setPlan(1);
    chain.setSub(1);
    db.setDunning({ subId: "1", attempts: 3, nextRetryAt: T0 + 7 * DAY_SECONDS, updatedAt: T0 });
    chain.addLog(MANAGER, managerEvent("Resumed", { subId: 1n }), 99n);
    await indexer.sync();
    assert.equal(db.getDunning("1"), undefined);
    db.close();
  });

  it("hydrates subscriptions from chain state, with a zero ref stored as null", async () => {
    const { chain, db, indexer } = setup();
    chain.setPlan(1);
    chain.setSub(1, { next: T0 + 123 });
    chain.setSub(2);
    chain.refs.set("2", `0x${"7f".repeat(32)}`);
    chain.addLog(MANAGER, managerEvent("Subscribed", { subId: 1n, subscriber: ALICE, planId: 1n, nextChargeAt: 0n, ref: ZERO_REF }), 99n);
    chain.addLog(MANAGER, managerEvent("Subscribed", { subId: 2n, subscriber: ALICE, planId: 1n, nextChargeAt: 0n, ref: ZERO_REF }), 99n);
    await indexer.sync();
    const s1 = db.getSubscription("1")!;
    assert.equal(s1.nextChargeAt, T0 + 123); // from chain, not from the event
    assert.equal(s1.merchant, MERCHANT);
    assert.equal(s1.ref, null);
    assert.equal(db.getSubscription("2")?.ref, `0x${"7f".repeat(32)}`);
    db.close();
  });

  it("skips subscriptions that do not exist on chain", async () => {
    const { db, indexer } = setup();
    await indexer.refreshSubscription("42");
    assert.equal(db.getSubscription("42"), undefined);
    db.close();
  });

  it("PlanCreated stores the plan; a plan that does not exist is skipped", async () => {
    const { chain, db, indexer } = setup();
    chain.setPlan(1, 5n);
    chain.addLog(MANAGER, managerEvent("PlanCreated", { planId: 1n, merchant: MERCHANT, price: 5n, cycleSeconds: BigInt(CYCLE) }), 99n);
    chain.addLog(MANAGER, managerEvent("PlanCreated", { planId: 9n, merchant: MERCHANT, price: 5n, cycleSeconds: BigInt(CYCLE) }), 99n);
    await indexer.sync();
    assert.deepEqual(db.listPlans().map((p) => [p.planId, p.price]), [["1", "5"]]);
    db.close();
  });

  it("ignores manager logs with an unknown topic", async () => {
    const { chain, db, indexer } = setup();
    chain.addLog(MANAGER, { topics: [`0x${"12".repeat(32)}`], data: "0x" }, 99n);
    const r = await indexer.sync();
    assert.equal(r.logs, 1);
    assert.equal(db.listSubscriptions().length, 0);
    db.close();
  });

  it("records USDC transfers into and out of the manager only", async () => {
    const { chain, db, indexer } = setup();
    chain.addLog(USDC, erc20Event(TRANSFER, ALICE, MANAGER, 1000n), 99n);
    chain.addLog(USDC, erc20Event(TRANSFER, MANAGER, MERCHANT, 990n), 99n);
    chain.addLog(USDC, erc20Event(TRANSFER, ALICE, OTHER, 5n), 99n); // not the manager
    await indexer.sync();
    const t = db.dedupedTransfers();
    assert.deepEqual(
      t.map((x) => [x.fromAddr, x.toAddr, x.amount]).sort(),
      [[ALICE, MANAGER, "1000"], [MANAGER, MERCHANT, "990"]].sort()
    );
    db.close();
  });

  it("an Approval to the manager marks the owner's funds stale, others do not", async () => {
    const { chain, db, indexer } = setup();
    chain.laxArgs = true; // the RPC returns approvals to anyone; the indexer must filter
    const funds = (s: string) => ({ subscriber: s, allowance: "0", balance: "0", per_cycle: "0", cycles_covered: 0, low: 1, checked_at: T0 });
    db.upsertFunds(funds(ALICE));
    db.upsertFunds(funds(OTHER));
    chain.addLog(USDC, erc20Event(APPROVAL, ALICE, MANAGER, 10n ** 9n), 99n);
    chain.addLog(USDC, erc20Event(APPROVAL, OTHER, MERCHANT, 10n ** 9n), 99n);
    await indexer.sync();
    assert.equal(db.getFunds(ALICE)?.checked_at, 0);
    assert.equal(db.getFunds(OTHER)?.checked_at, T0);
    assert.equal(db.dedupedTransfers().length, 0); // approvals are not movements
    db.close();
  });

  it("backfillAll loads every plan and subscription", async () => {
    const { chain, db, indexer } = setup();
    chain.setPlan(1);
    chain.setPlan(2, 2n * PRICE);
    chain.setSub(1);
    chain.setSub(2, { planId: 2 });
    assert.equal(await indexer.backfillAll(), 2);
    assert.equal(db.listPlans().length, 2);
    assert.equal(db.getSubscription("2")?.price, (2n * PRICE).toString());
    db.close();
  });
});

function keeperSetup() {
  const chain = new FakeChain();
  const db = new LevyDb(":memory:");
  const keeper = new Keeper(cfg(), chain.clients(), db);
  chain.setPlan(1);
  return { chain, db, keeper };
}

describe("Keeper.runCycle: charging and retries", () => {
  async function hydrated(subs: Array<[number, Parameters<FakeChain["setSub"]>[1]]>) {
    const k = keeperSetup();
    for (const [id, o] of subs) k.chain.setSub(id, o);
    await new Indexer(cfg(), k.chain.clients(), k.db).backfillAll();
    return k;
  }

  it("charges due subscriptions and reports the tx", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }], [2, { next: T0 + 1 }]]);
    const r = await keeper.runCycle();
    assert.deepEqual(r.charged.map((c) => c.subId), ["1"]); // sub 2 is not due yet
    assert.match(r.charged[0].txHash, /^0x/);
    assert.deepEqual(chain.chargeCalls, ["1"]);
    assert.equal(r.syncedLogs, 1); // the second sync picked up our own Charged log
    assert.equal(db.listCharges({ subId: "1" }).length, 1);
    db.close();
  });

  it("reports a ChargeFailed receipt as a payment failure without error backoff", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }]]);
    chain.chargeResults.push({ events: [{ name: "ChargeFailed", args: { subId: 1n, failedAttempts: 1n } }] });
    const r = await keeper.runCycle();
    assert.deepEqual(r.failed, [{ subId: "1", error: "ChargeFailed" }]);
    // The receipt's log reached the DB in the same cycle: dunning owns the retry.
    assert.equal(db.getDunning("1")?.nextRetryAt, T0 + DAY_SECONDS);
    assert.equal(db.dueSubscriptions(T0).length, 0);
    db.close();
  });

  it("backs off 1m, 5m, 15m, 1h, then 6h after non-payment errors", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }]]);
    const delays = [60, 300, 900, 3600, 21600, 21600];
    for (const delay of delays) {
      chain.chargeResults.push({ revert: true });
      const before = chain.chargeCalls.length;
      const r = await keeper.runCycle();
      assert.equal(chain.chargeCalls.length, before + 1);
      assert.deepEqual(r.failed, [{ subId: "1", error: "charge reverted" }]);
      // Held back until the delay has passed, then tried again.
      chain.time += delay - 1;
      await keeper.runCycle();
      assert.equal(chain.chargeCalls.length, before + 1, `held back before ${delay}s`);
      chain.time += 1;
    }
    db.close();
  });

  it("a success clears the backoff, so the next error starts at 1m again", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }]]);
    chain.chargeResults.push({ revert: true });
    await keeper.runCycle();
    chain.time += 60;
    chain.chargeResults.push({ revert: true });
    await keeper.runCycle(); // second error: 5m
    chain.time += 300;
    await keeper.runCycle(); // success (default result)
    assert.equal(chain.chargeCalls.length, 3);

    // The sub is due again (the fake chain did not advance nextChargeAt).
    chain.chargeResults.push({ revert: true });
    await keeper.runCycle();
    chain.time += 60;
    await keeper.runCycle();
    assert.equal(chain.chargeCalls.length, 5);
    db.close();
  });

  it("re-reads the subscription from chain after an error", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }]]);
    // The DB row is stale: on chain the sub was already charged and is not due.
    chain.setSub(1, { next: T0 + CYCLE });
    chain.chargeResults.push({ revert: true });
    await keeper.runCycle();
    assert.equal(db.getSubscription("1")?.nextChargeAt, T0 + CYCLE);
    db.close();
  });

  it("reports RPC errors by their short message", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }]]);
    chain.chargeResults.push({ throws: Object.assign(new Error("long message"), { shortMessage: "nonce too low" }) });
    const r = await keeper.runCycle();
    assert.deepEqual(r.failed, [{ subId: "1", error: "nonce too low" }]);
    db.close();
  });

  it("ignores receipt logs from other contracts or for other subscriptions", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 }]]);
    chain.chargeResults.push({
      events: [
        { address: OTHER, name: "Charged", args: chargedArgs("1") },
        { name: "Charged", args: chargedArgs("2") },
        { name: "ChargeFailed", args: { subId: 3n, failedAttempts: 1n } },
      ],
    });
    const r = await keeper.runCycle();
    assert.deepEqual(r.failed, [{ subId: "1", error: "no Charged event in receipt" }]);
    db.close();
  });

  it("retries due dunning entries and reports them as retried", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 - DAY_SECONDS, status: Status.PAST_DUE, failed: 2 }]]);
    db.setDunning({ subId: "1", attempts: 2, nextRetryAt: T0, updatedAt: T0 - 3 * DAY_SECONDS });
    const r = await keeper.runCycle();
    assert.deepEqual(r.retried.map((x) => x.subId), ["1"]);
    assert.equal(r.charged.length, 0);
    assert.equal(db.getDunning("1"), undefined); // cleared by the Charged log
    db.close();
  });

  it("does not retry a dunning entry before its time", async () => {
    const { chain, db, keeper } = await hydrated([[1, { next: T0 - DAY_SECONDS, status: Status.PAST_DUE, failed: 2 }]]);
    db.setDunning({ subId: "1", attempts: 2, nextRetryAt: T0 + 1, updatedAt: T0 });
    await keeper.runCycle();
    assert.equal(chain.chargeCalls.length, 0);
    db.close();
  });

  it("drops dunning entries for paused, cancelled or unknown subscriptions without charging", async () => {
    const { chain, db, keeper } = await hydrated([
      [1, { status: Status.PAUSED }],
      [2, { status: Status.CANCELLED }],
    ]);
    for (const id of ["1", "2", "99"]) db.setDunning({ subId: id, attempts: 4, nextRetryAt: T0, updatedAt: T0 });
    await keeper.runCycle();
    assert.equal(chain.chargeCalls.length, 0);
    assert.equal(db.dueRetries(T0 + 365 * DAY_SECONDS).length, 0);
    db.close();
  });

});

describe("Keeper.runCycle: allowance runway", () => {
  async function fundsSetup(allowance: bigint) {
    const k = keeperSetup();
    k.chain.setSub(1, { next: T0 + CYCLE });
    k.chain.allowance.set(ALICE, allowance);
    await new Indexer(cfg(), k.chain.clients(), k.db).backfillAll();
    k.db.registerWebhook(MERCHANT, "https://example.com/hook", ["allowance.low"], T0);
    return k;
  }

  it("warns the merchant once when the allowance runs low", async () => {
    const { chain, db, keeper } = await fundsSetup(PRICE); // one cycle left, below WARN_CYCLES
    await keeper.runCycle();
    const f = db.getFunds(ALICE)!;
    assert.equal(f.low, 1);
    assert.equal(f.cycles_covered, 1);
    assert.equal(f.per_cycle, PRICE.toString());
    assert.equal(db.listDeliveries({ merchant: MERCHANT }).length, 1);

    // Still low on the next check: no repeat warning.
    chain.time += 7 * 3600;
    await keeper.runCycle();
    assert.equal(db.listDeliveries({ merchant: MERCHANT }).length, 1);
    db.close();
  });

  it("does not warn while the allowance covers enough cycles, and caps unlimited approvals", async () => {
    const { db, keeper } = await fundsSetup(2n ** 256n - 1n);
    await keeper.runCycle();
    const f = db.getFunds(ALICE)!;
    assert.equal(f.low, 0);
    assert.equal(f.cycles_covered, 1_000_000);
    assert.equal(db.listDeliveries({ merchant: MERCHANT }).length, 0);
    db.close();
  });

  it("leaves the subscriber unchecked when the RPC read fails", async () => {
    const { chain, db, keeper } = await fundsSetup(PRICE);
    chain.readFails = true;
    await keeper.runCycle();
    assert.equal(db.getFunds(ALICE), undefined);
    chain.readFails = false;
    await keeper.runCycle();
    assert.equal(db.getFunds(ALICE)?.low, 1);
    db.close();
  });
});

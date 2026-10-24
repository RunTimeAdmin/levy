import { createClients } from "./chain.js";
import { loadConfig, redactRpcUrl } from "./config.js";
import { LevyDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { Keeper } from "./keeper.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const clients = createClients(cfg);
  const db = new LevyDb(cfg.dbPath);

  const once = process.argv.includes("--once");

  console.log(
    `levy keeper: chain=${cfg.chainId} manager=${cfg.managerAddress} keeper=${clients.account.address}`
  );
  console.log(`webhook signing key: ${cfg.webhookKeyPath} (public key at GET /api/webhooks/public-key)`);

  // First boot: hydrate subscription state from chain.
  const indexer = new Indexer(cfg, clients, db);
  const n = await indexer.backfillAll();
  console.log(`backfilled ${n} subscriptions`);

  const keeper = new Keeper(cfg, clients, db);

  const cycle = async () => {
    try {
      const r = await keeper.runCycle();
      if (r.charged.length || r.retried.length || r.failed.length) {
        console.log(
          `[cycle] charged=${r.charged.length} retried=${r.retried.length} failed=${r.failed.length} logs=${r.syncedLogs}`
        );
        for (const f of r.failed) console.log(redactRpcUrl(`  ! sub ${f.subId}: ${f.error}`));
      }
    } catch (e: any) {
      console.error(redactRpcUrl(`[cycle] error: ${e?.message ?? e}`));
    }
  };

  // Webhook retry times are wall-clock; on Arc block timestamps track it closely.
  const deliver = async () => {
    try {
      const r = await keeper.webhooks.dispatchDue(Math.floor(Date.now() / 1000));
      if (r.sent || r.failed || r.dead) {
        console.log(`[webhooks] sent=${r.sent} failed=${r.failed} dead=${r.dead}`);
      }
    } catch (e: any) {
      console.error(redactRpcUrl(`[webhooks] error: ${e?.message ?? e}`));
    }
  };

  if (once) {
    await cycle();
    await deliver();
    db.close();
    return;
  }

  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  // Two independent loops: charging never waits on a merchant's webhook endpoint.
  const loop = async (pass: () => Promise<void>, ms: number) => {
    while (!stopped) {
      await pass();
      await sleep(ms);
    }
  };
  await Promise.all([loop(cycle, cfg.pollIntervalMs), loop(deliver, cfg.webhookPollMs)]);
  db.close();
}

main().catch((e) => {
  // The stack includes the message, and viem's messages include the RPC URL.
  console.error(redactRpcUrl(String(e?.stack ?? e)));
  process.exit(1);
});

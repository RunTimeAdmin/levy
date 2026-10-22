import { setTimeout as sleep } from "node:timers/promises";
import { createClients } from "./chain.js";
import { loadConfig } from "./config.js";
import { LevyDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { Keeper } from "./keeper.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const clients = createClients(cfg);
  const db = new LevyDb(cfg.dbPath);

  const once = process.argv.includes("--once");

  console.log(
    `levy keeper: chain=${cfg.chainId} manager=${cfg.managerAddress} keeper=${clients.account.address}`
  );
  console.log(`webhook signing key: ${cfg.webhookKeyPath} (public key at GET /api/webhooks/public-key)`);

  // Every boot: re-read every plan and subscription from chain (the source of
  // truth), so rows that went stale while the keeper was down are fixed.
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
        for (const f of r.failed) console.log(`  ! sub ${f.subId}: ${f.error}`);
      }
    } catch (e: any) {
      console.error(`[cycle] error: ${e?.message ?? e}`);
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
      console.error(`[webhooks] error: ${e?.message ?? e}`);
    }
  };

  if (once) {
    await cycle();
    await deliver();
    db.close();
    return;
  }

  // A stop signal lets the pass in progress finish (a sent charge still gets
  // its receipt read) and cuts the sleep short. Waiting out a 30s sleep would
  // overrun `docker stop`'s 10s grace period and end in a SIGKILL.
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  // Two independent loops: charging never waits on a merchant's webhook endpoint.
  const loop = async (pass: () => Promise<void>, ms: number) => {
    while (!stop.signal.aborted) {
      await pass();
      await sleep(ms, undefined, { signal: stop.signal }).catch(() => undefined);
    }
  };
  await Promise.all([loop(cycle, cfg.pollIntervalMs), loop(deliver, cfg.webhookPollMs)]);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

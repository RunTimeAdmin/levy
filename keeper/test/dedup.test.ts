import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LevyDb } from "../src/db.js";

const TX_A = "0xaaa";
const TX_B = "0xbbb";
const ALICE = "0xalice";
const MERCHANT = "0xmerchant";

describe("EIP-7708 transfer dedup", () => {
  it("collapses native + ERC-20 face duplicates of one movement", () => {
    const db = new LevyDb(":memory:");
    // Same economic movement, two logs (native layer + ERC-20 face).
    assert.equal(
      db.insertTransfer({ txHash: TX_A, logIndex: 0, fromAddr: ALICE, toAddr: MERCHANT, amount: "1000", blockNumber: 1 }),
      true
    );
    assert.equal(
      db.insertTransfer({ txHash: TX_A, logIndex: 5, fromAddr: ALICE, toAddr: MERCHANT, amount: "1000", blockNumber: 1 }),
      true
    );
    const deduped = db.dedupedTransfers();
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].amount, "1000");
    db.close();
  });

  it("keeps genuinely distinct movements in the same transaction", () => {
    const db = new LevyDb(":memory:");
    db.insertTransfer({ txHash: TX_A, logIndex: 0, fromAddr: ALICE, toAddr: MERCHANT, amount: "1000", blockNumber: 1 });
    db.insertTransfer({ txHash: TX_A, logIndex: 1, fromAddr: ALICE, toAddr: MERCHANT, amount: "2500", blockNumber: 1 });
    assert.equal(db.dedupedTransfers().length, 2);
    db.close();
  });

  it("ignores reprocessing of the same log", () => {
    const db = new LevyDb(":memory:");
    const t = { txHash: TX_A, logIndex: 0, fromAddr: ALICE, toAddr: MERCHANT, amount: "1000", blockNumber: 1 };
    assert.equal(db.insertTransfer(t), true);
    assert.equal(db.insertTransfer(t), false); // same (txHash, logIndex): no-op
    assert.equal(db.dedupedTransfers().length, 1);
    db.close();
  });

  it("keeps identical movements from different transactions", () => {
    const db = new LevyDb(":memory:");
    db.insertTransfer({ txHash: TX_A, logIndex: 0, fromAddr: ALICE, toAddr: MERCHANT, amount: "1000", blockNumber: 1 });
    db.insertTransfer({ txHash: TX_B, logIndex: 0, fromAddr: ALICE, toAddr: MERCHANT, amount: "1000", blockNumber: 2 });
    assert.equal(db.dedupedTransfers().length, 2);
    db.close();
  });
});

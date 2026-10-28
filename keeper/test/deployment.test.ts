import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LevyDb, deploymentId } from "../src/db.js";

const MANAGER = "0x00000000000000000000000000000000000000Aa";
const OTHER = "0x00000000000000000000000000000000000000bB";
const USDC = "0x3600000000000000000000000000000000000000";

describe("LevyDb.bindDeployment", () => {
  it("records the deployment on a fresh database and accepts it again", () => {
    const db = new LevyDb(":memory:");
    const id = deploymentId(5042002, MANAGER, USDC);
    db.bindDeployment(id);
    db.bindDeployment(deploymentId(5042002, MANAGER.toLowerCase(), USDC));
    assert.equal(db.deployment(), id);
    db.close();
  });

  it("refuses a database recorded for another manager or chain", () => {
    const db = new LevyDb(":memory:");
    db.bindDeployment(deploymentId(5042002, MANAGER, USDC));
    assert.throws(() => db.bindDeployment(deploymentId(5042002, OTHER, USDC)), /belongs to/);
    assert.throws(() => db.bindDeployment(deploymentId(5042, MANAGER, USDC)), /belongs to/);
    db.close();
  });

  it("refuses a database with data from before the record was kept", () => {
    const db = new LevyDb(":memory:");
    db.setSync("manager_events_from_block", "123");
    assert.throws(() => db.bindDeployment(deploymentId(5042002, MANAGER, USDC)), /no record of its deployment/);
    db.close();
  });

  it("does not count the webhook delivery epoch as data", () => {
    const db = new LevyDb(":memory:");
    db.deliveryEpoch();
    db.bindDeployment(deploymentId(5042002, MANAGER, USDC));
    db.close();
  });
});

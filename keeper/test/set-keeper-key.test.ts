import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ops/set-keeper-key.sh, run against a scratch env file. docker and python3
// are stubbed; sed, awk, perl and tee are wrapped to log their arguments, so
// the test sees whether the key ever lands on a command line.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ops", "set-keeper-key.sh");
const KEY = `0x${"ab".repeat(32)}`; // a placeholder, not anyone's key
const ADDR = "0x000000000000000000000000000000000000dEaD";

const tmp = mkdtempSync(join(tmpdir(), "levy-setkey-"));
const bin = join(tmp, "bin");
const argvLog = join(tmp, "argv.log");
mkdirSync(bin);
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
stub("docker", `cat > /dev/null; echo ${ADDR}`);
stub("python3", "exit 1");
for (const tool of ["sed", "awk", "perl", "tee"]) {
  const real = spawnSync("bash", ["-c", `command -v ${tool}`]).stdout.toString().trim();
  if (!real) continue;
  stub(tool, `printf '%s\\n' "${tool} $*" >> ${JSON.stringify(argvLog)}\nexec ${JSON.stringify(real)} "$@"`);
}

after(() => rmSync(tmp, { recursive: true, force: true }));

function run(envFile: string, input: string) {
  writeFileSync(argvLog, "");
  const r = spawnSync("bash", [SCRIPT], {
    input: `${input}\n`,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LEVY_ENV_FILE: envFile },
  });
  return { status: r.status, out: r.stdout.toString() + r.stderr.toString(), argv: readFileSync(argvLog, "utf8") };
}

describe("ops/set-keeper-key.sh", () => {
  it("replaces the key line, keeps the rest, and never passes the key as an argument", () => {
    const env = join(tmp, "replace.env");
    writeFileSync(env, "LEVY_RPC_URL=\nLEVY_KEEPER_KEY=0xold\nLEVY_CHAIN_ID=5042002\n", { mode: 0o644 });
    const r = run(env, KEY);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes(`Keeper address: ${ADDR}`), r.out);
    assert.equal(readFileSync(env, "utf8"), `LEVY_RPC_URL=\nLEVY_KEEPER_KEY=${KEY}\nLEVY_CHAIN_ID=5042002\n`);
    assert.equal(statSync(env).mode & 0o777, 0o600);
    assert.ok(!r.argv.includes(KEY.slice(2)), `key on a command line:\n${r.argv}`);
    assert.ok(!r.out.includes(KEY.slice(2)), "key echoed");
  });

  it("adds the key line when the file has none, instead of saving nothing", () => {
    const env = join(tmp, "append.env");
    writeFileSync(env, "LEVY_RPC_URL=\n");
    const r = run(env, KEY.slice(2)); // without 0x: the script adds it
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(env, "utf8"), `LEVY_RPC_URL=\nLEVY_KEEPER_KEY=${KEY}\n`);
  });

  it("refuses an address and leaves the file untouched", () => {
    const env = join(tmp, "address.env");
    writeFileSync(env, "LEVY_KEEPER_KEY=0xold\n");
    const r = run(env, ADDR);
    assert.equal(r.status, 1);
    assert.ok(r.out.includes("ADDRESS"), r.out);
    assert.equal(readFileSync(env, "utf8"), "LEVY_KEEPER_KEY=0xold\n");
  });

  it("leaves no temporary copy of the file behind", () => {
    const leftovers = spawnSync("bash", ["-c", `ls ${JSON.stringify(tmp)} | grep -c '\\.env\\.' || true`]).stdout.toString().trim();
    assert.equal(leftovers, "0");
    assert.ok(existsSync(join(tmp, "replace.env")));
  });
});

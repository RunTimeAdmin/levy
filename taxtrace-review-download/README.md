# TaxTrace code review bundle

Review of RunTimeAdmin/taxtrace at commit `86772c7` (main, 2026-10-22).

| Path | What it is |
|---|---|
| `REVIEW.md` | The full review: architecture, problem areas, prioritized refactoring plan, before/after code, open questions |
| `patches/taxtrace-refactor.patch` | Verified non-breaking TypeScript changes (14 files across core, reports, reports-api, including 4 new tests) |
| `patches/taxtrace-contracts.patch` | Verified non-breaking Solidity de-duplication (Vault.sol, Harvester.sol) |
| `probes/` | Scripts that reproduce the reports and API findings (C1, C2, C3, C4, C14, C15) |
| `bot-experiments/` | The bot reviewer's scripts for the indexer findings (C5 to C9) and the matcher/statement-cache benchmarks |
| `logs/` | Install, typecheck, lint and read-only build output for `app` and `admin` |

## Apply the patches

From the root of a taxtrace checkout:

```bash
git apply --check /path/to/patches/taxtrace-refactor.patch && git apply /path/to/patches/taxtrace-refactor.patch
git apply --check /path/to/patches/taxtrace-contracts.patch && git apply /path/to/patches/taxtrace-contracts.patch
```

Then run the same checks CI runs:

```bash
cd core && npm ci && npm run build && npm test && cd ..
for pkg in reports reports-api; do (cd "$pkg" && npm ci && npm run build && npm test); done
forge fmt --check && forge build && forge test
```

Expected: core 15/15, reports 89/89, reports-api 23/23, forge 109/109.

Two of the new reports tests and the new reports-api test fail on unpatched main. That's on purpose: they're the regression tests for C4 and C1.

## Run the probes

Copy `probes/` into the root of a taxtrace checkout, then build core, reports and reports-api first:

```bash
node --experimental-sqlite probes/probe-reports.js      # guards, holding period, wash window, lookup count, anchored flag
node --experimental-sqlite probes/probe-api.js crash    # unpatched: process exits 1. Patched: survives
node --experimental-sqlite probes/probe-api.js nonce    # second nonce request locks the victim out (401)
```

## Run the bot experiments

Build `bot`, then pass its compiled output directory as the first argument:

```bash
node --experimental-sqlite bot-experiments/exp1.js <taxtrace>/bot/dist         # E1-E5: reorg, wallet-to-wallet, self-transfer, SpecID re-promotion, RPC error
node --experimental-sqlite bot-experiments/exp2.js <taxtrace>/bot/dist         # reorg on both sources, abort-listener leak
node --experimental-sqlite bot-experiments/matcherFast.js <taxtrace>/bot/dist  # faster matcher, fuzzed for identical output
node --experimental-sqlite bot-experiments/bench.js <taxtrace>/bot/dist        # matcher scaling, prepared-statement cache
node --experimental-sqlite bot-experiments/eqp.js <taxtrace>/bot/dist          # EXPLAIN QUERY PLAN for the hot queries
```

Note: the bot's `prebuild`/`pretest` hook rewrites `src/db/schema.gen.ts`. Run it on a scratch copy if you want a clean tree.

## Disclaimer

The tax findings (holding period, wash-sale window, basis carryover, Form 8949 boxes) are engineering observations, not tax advice. Have a qualified tax preparer confirm the rules before you change report logic.

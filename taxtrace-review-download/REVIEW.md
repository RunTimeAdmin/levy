# TaxTrace code review and refactoring analysis

Repository: RunTimeAdmin/taxtrace, commit `86772c7` (main). Reviewed 2026-10-22.

Coverage: core, contracts, reports, reports-api and sdk were reviewed line by line. `bot` and the two Next.js apps (`app`, `admin`) were reviewed by two parallel reviewers, and every High finding they reported that is listed here was re-checked against the code.

Short version: the architecture is careful and heavily defended, but several of those defenses don't do what their comments say. Two tax rules are measured in seconds where the IRS counts calendar days.

## 1. Architecture Summary

```
Robinhood Chain (Arbitrum Orbit, 4663)
  ERC-20 Transfer + UniV3 Swap logs              Harvester/Reporter logs (managed tier)
        │ GenericChainSource                           │ EthersChainSource
        └──────────► bot Indexer (confirmations, reorg check, one DB transaction per block range)
                        │ processed_logs dedupe → tax_lots / pending_dispositions
                        │ off-chain FIFO/SpecID matcher → dispositions
                        ▼
                  SQLite ledger (node:sqlite, WAL)
                        │ read-only handle             │ two guarded write handles
                        ▼                              ▼
   reports: ReportGenerator → §1091 rule (core) → Merkle root (core) → 8949 / CSV / Koinly / TurboTax
                        │
   reports-api (node:http): SIWE /api/*  +  tenant X-API-Key /v1/tenant/* (membership-gated, metered)
                        │
          sdk (typed fetch client)     app (customer dApp)     admin (operator console)
   Reporter.anchorReport(reportId, root): first anchor for an ID is final, can't be overwritten
```

Patterns worth keeping:
- A layered pipeline: ingest, ledger, report, API.
- Swappable boundary interfaces (`ChainSource`, `DispositionSource`, `NonceStore`, `RateLimiter`, `BillingProvider`).
- A pure shared core: `@taxtrace/core` holds the frozen leaf hash, the report IDs and the §1091 rule.
- A route table that is the actual dispatch surface, not a copy of it.
- BigInt money end to end. No float math on tax amounts was found.

Anti-patterns:
- Oversized modules: `bot/src/db/index.ts` is 1,891 lines and `reports/src/db.ts` is 1,227.
- Report generation runs synchronous SQLite on the API's event loop.
- The matcher and the coverage loop recompute full history every time.
- About 1,150 lines plus 3,500 ABI lines are copy-pasted between `app` and `admin`.
- "Structural" guarantees are built as denylists.

## 2. Problem Areas

How each finding was checked:
- Proved: reproduced with a script (see `probes/` and `bot-experiments/`).
- Code: confirmed by reading the code.
- Sub: a reviewer reproduced it; the code path was checked but not rerun.

### Correctness and security (these outrank the refactoring work)

| # | Sev | Where | Problem | Evidence |
|---|---|---|---|---|
| C1 | Critical | reports-api/src/server.ts:946 | `new URL(req.url, "http://" + Host)` runs before the `try`. One request with `Host: bad host` crashes the process. It's a remote DoS that needs no auth. | Proved (exit 1) |
| C2 | High | reports/src/generator.ts:94,166 (same code in bot/src/report/variant.ts) | Holding period is `seconds <= 365*86400`. In IRS Pub. 550's own example (bought 2/5/2024, sold 2/5/2025) the sale is short-term; the code says long-term. | Proved |
| C3 | High | core/src/washsale.ts:82 | The ±30-day wash-sale window is measured in seconds, so a replacement bought on day +30, later in the day than the sale, is missed. | Proved |
| C4 | High | reports/src/db.ts:909-1133 | Both write guards are denylists that have fallen behind the schema: 14 names listed, 24 tables exist. Statements like `UPDATE tenant_api_keys` and `DELETE FROM declared_basis` / `processed_logs` / `indexer_checkpoints` pass. `api_keys` / `usage_events` never match the real `tenant_*` tables. No current code issues these statements, so it's a broken invariant rather than a live exploit, but the tests call it an "allowlist". | Proved |
| C5 | High | bot/src/chain/source.ts:54, genericSource.ts:170 | `getBlockHash` returns cached hashes, so the reorg check compares the checkpoint against itself. Reorgs are only caught after a restart. | Code + Sub |
| C6 | High | bot genericSource.ts:292,326 with indexer.ts:156 | A→B between two covered wallets emits both events with the same (tx, logIndex). Dedupe then drops B's acquisition. | Code + Sub |
| C7 | High | bot/src/pricing/ethersPriceSource.ts:134 | A bare `catch` treats a 429 or timeout as "round missing" and bisects earlier, so an older Chainlink price is committed permanently. | Code + Sub |
| C8 | High | bot/src/ingestion/matcher.ts:471-501 | Re-promotion after a SpecID edit uses `INSERT OR IGNORE`, so old and new slices coexist: 150 units sold shows as 200. | Sub |
| C9 | High | bot genericSource.ts:254 | A self-transfer (A→A) creates a phantom lot with UNKNOWN basis, which also counts as a wash-sale replacement. | Sub |
| C10 | High | app ReportsPanel.tsx:248 | Rows show raw gain/loss while the summary shows the post-§1091 net. The W adjustment never appears, so the screen shows a wrong tax number. | Code |
| C11 | High | app HarvestPanel.tsx:383,395 and BatchHarvestPanel.tsx:335 | The oracle floor and minimum output are in buy-token units but formatted with sell-token decimals. The minimum the user approves is displayed off by 10^Δdecimals. | Code |
| C12 | High | app lib/config.ts:97 | `isConfigured` requires Harvester and Guard, so the read-only build shows "Not configured" on /reports, its only feature. | Code + Sub (build) |
| C13 | High | app ReportsPanel.tsx:286,325; ui.tsx:142 | Amounts are hardcoded to 18 decimals. The badge labels INFERRED_SWAP as "Verified" and UNKNOWN ($0 basis) as "Self-declared". | Sub |
| C14 | Medium | reports-api nonceStore.ts, server.ts:659 | Challenges are keyed by address, so anyone can overwrite your nonce while you're signing. The per-address limiter is keyed on the victim, which makes it cheap. Result: a targeted SIWE login lockout. | Proved (401) |
| C15 | Medium | reports/src/db.ts:231-258 | Regenerating a report keeps `anchored=1` and the old tx hash next to a new root that was never anchored. | Proved |
| C16 | Medium | app useReportsAuth.ts | The session isn't bound to the connected address. Switching wallets mid-sign shows A's records under B and can feed A's SpecID lot IDs into B's transaction. | Sub |
| C17 | Medium | Harvester._executeSwap | It trusts the router's returned `amountOut` instead of a balance delta, and the owner can repoint the router. There's no L2 sequencer-uptime check on Chainlink. Managed tier only. | Code |
| C18 | Low | Reporter.onlyEmitter | The owner can emit forged Deposited/HarvestExecuted events into the "immutable audit trail". Managed tier only. | Code |

### Structure

- [M] `bot/src/db/index.ts` mixes the SQLite binding, about 630 lines of migrations (v1 to v15) and around 12 repositories. It has 7 clean clusters, so it can be split behind the existing barrel.
- [M] `Indexer.applyLog` (indexer.ts:229-424) switches on both sources' event names, which ties the indexer to every event schema.
- [M] UI components fetch, decide and render all at once (HarvestPanel: 477 lines, 12 data hooks). BatchActionRow re-implements about 70% of it and has already drifted: its allowance check runs per leg, not per vault.
- [M] Report generation is synchronous on the API's event loop, so one 10k-row report stalls every tenant.
- [L] The bot's "imports no custodial contract at runtime" claim is false: `index.ts` statically requires the managed-tier modules.

### Duplication

- [M] In `reports/src/db.ts`, `getUserDispositions` exists twice, `getAssetClass` twice, and the tax-year bounds three times. The SQLite loader is also copied into `tenants.ts`. Fixed in the patch.
- [M] `bot/src/report/variant.ts` re-implements the generator's leaf-row logic (isShortTerm, description, year bounds, sort). These fields feed anchored roots, and nothing guards against drift.
- [M] `app` and `admin` share about 1,155 copied lines plus 3,561 ABI lines. The ABIs are copied by hand with no CI check, and `formatDuration` and the config parsers have already diverged.
- [L] The wash-sale figure math is repeated in four formatters, the two limit/offset parsers are near-copies, and Vault's withdraw/redeem tails are identical. All three are fixed in the patches.
- [L] `bot/src/washsale.ts` (WashSaleChecker) is a second §1091 rule with its own window constant. It counts the sold lot's own buy as a replacement; core skips it. That's conservative, but it is a second rule.

### Performance

- [H] The wash-sale rule calls `classOf` inside its dispositions × acquisitions loop, and on the report path each call is a SQLite query. 200×200 gives 40,200 queries per report. Proved; the patch brings it to 1.
- [H] The bot's coverage loop rescans the whole chain for every wallet every minute, ignoring `MAX_RANGE` (Sub).
- [H] The UniV3 Swap `getLogs` has no address filter, so it fetches every swap on the chain in the range (Sub).
- [M] The matcher is O(S×L) and re-matches each pair's full history. 8k lots/sells take 673 ms, versus 12 ms with a prefix binary search that gave identical output on 3,000 fuzz cases (Sub, `bot-experiments/matcherFast.js`).
- [M] There's no prepared-statement cache (3.4× slower inserts in the bot) and no `busy_timeout`, while the bot and the API writers share one file (Sub, `bot-experiments/bench.js`).
- [M] Hot paths are missing indexes, confirmed with EXPLAIN (Sub, `bot-experiments/eqp.js`).
- [M] Each page of a paged report regenerates the full report.
- [M] `/harvest` pulls in all of ethers through the core barrel: 505 kB first load versus 339 kB with a subpath import (Sub, measured).

### Maintainability

- [M] `tenantUser` meters before validating, so a 400 or 413 report request still bills 5 units.
- [M] Several comments are misleading:
  - `core/src/types.ts` cites a reports copy of the file that no longer exists (fixed in the patch).
  - `constantTimeEqualHex` runs after a by-hash lookup, so it compares a value to itself.
  - `TenantControlDatabase` forces WAL mode on the ledger file. `MembershipRepository` documents why it deliberately doesn't.
- [L] Config parsing is too loose:
  - Negative and float values are accepted; `MAX_RANGE=0` sends the bot into a hot loop.
  - `feed_decimals ?? 8` silently assumes 8 decimals.
  - The CLI accepts a NaN year.
- [L] The SDK interpolates `user` into paths without encoding.
- [L] `schema.gen.ts` is committed as CRLF but regenerated as LF, so every build dirties the tree.

## 3. Refactoring Strategies

### High

1. Close C1. Parse the URL against a fixed base inside the error boundary; the Host header was never used for routing. Done in the patch, with a regression test.
2. Make the write guards fail closed (C4). One guard factory, complete deny-lists, and a test that reads every table out of `bot/src/db/schema.sql`. Done in the patch, and the test fails on current main. Longer term, put the control-plane tables in their own SQLite file so the ledger file is never opened read-write.
3. Remove the O(D×A) lookups with a lazy class cache in core and a per-report memo in the generator. Done in the patch. The golden-vector and determinism suites pass, so the roots are unchanged.
4. Fix the bot ingestion bugs (C5 to C9) as bug fixes:
   - Fetch block hashes from the node instead of the cache.
   - Apply every event in a (tx, logIndex) group.
   - Skip self-transfers.
   - Re-throw a typed transient RPC error instead of swallowing it.
   - Use DELETE+INSERT when re-promoting a pair.

   Output changes only where it's wrong today, but plan a re-index.
5. Decide the calendar-day policy (C2, C3) before writing code. These fields are in the Merkle leaf, so fixing them changes roots. See the open questions below.

### Medium

6. Split `bot/src/db/index.ts` behind its barrel; the exports stay the same.
7. Add a statement cache and `PRAGMA busy_timeout = 5000` to both DB layers.
8. Move the leaf-row logic into core (`toReportRow`, `isShortTerm`, `taxYearBounds`). Do this before step 5 so the date fix lands once.
9. SIWE: key challenges by nonce, accept an optional `nonce` in /auth/verify so old clients keep working, and rate-limit the pre-auth routes by IP only.
10. Make `persistReport` reset `anchored` when the root changes (4.7).
11. Frontend correctness batch: C10 to C13 and C16, plus UTC dates.
12. Create a shared package for app and admin, and generate both apps' ABIs from `bot/scripts/prepare.js` with a CI diff check.
13. Move report generation off the event loop (worker_threads), or cache by report ID plus a ledger high-water mark.

### Low

14. A `ReporterAware` base contract, `STREAM_*` constants, an `int(min)` config helper, `encodeURIComponent` in the SDK paths, metering after success, and `.gitattributes` for the schema files.

## 4. Improved Code

### Verification

| Suite | Before | After |
|---|---|---|
| core | 15/15 | 15/15 |
| reports | 86/86 | 89/89 (3 new guard tests; 2 of them fail on current main) |
| reports-api | 22/22 | 23/23 (1 new regression test; fails on current main) |
| forge | 109/109 | 109/109, `fmt --check` clean |

The reviewers also confirmed bot at 118/118 and app/admin at 0 typecheck and 0 lint errors.

Observable changes in the patches:
- An unparseable request URL now gets a 400 instead of killing the process.
- The guards reject more tables; no existing statement touches them.
- One new additive export, `washSaleFigures`.

Everything else produces identical output.

### 4.1 API crash (C1), `reports-api/src/server.ts`

```ts
// BEFORE: outside the try, so a bad Host header is an unhandled rejection
const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

// AFTER: fixed base (only pathname/searchParams are used), failure answered with a 400
let url: URL;
try {
  url = new URL(req.url ?? '/', 'http://localhost');
} catch {
  return sendJson(res, 400, { error: 'bad request' });
}
```

### 4.2 Write guards (C4), `reports/src/db.ts`

```ts
// BEFORE (x2): a new RegExp per table per statement, over a hand-kept list that drifted
for (const table of LEDGER_TABLES_FORBIDDEN_TO_MEMBERSHIP) {
  if (new RegExp(`\\b${table}\\b`).test(lowered)) throw new Error(/* ... */);
}

// AFTER: one factory, regexes compiled once, same exported signatures and error text
function singleTableGuard(handleName: string, section: string, allowedTable: string,
                          forbidden: readonly string[]): (sql: string) => void {
  const patterns = forbidden.map((table) => ({ table, re: new RegExp(`\\b${table}\\b`) }));
  return (sql) => {
    const lowered = sql.toLowerCase();
    for (const { table, re } of patterns) {
      if (re.test(lowered)) {
        throw new Error(`${handleName} is a control-plane-only handle (${section}); it may write ` +
          `${allowedTable} but never the ledger table "${table}".`);
      }
    }
  };
}
export function assertControlPlaneOnly(sql: string): void { membershipGuard(sql); }

// NEW TEST: pins both lists to bot/src/db/schema.sql so they can't drift again
for (const table of schemaTables().filter((t) => t !== 'wallet_tenant_membership')) {
  assert.throws(() => assertControlPlaneOnly(`DELETE FROM ${table}`), /control-plane-only/, table);
}
```

The lists also gain `tenant_api_keys`, `tenant_usage_events`, `declared_basis`, `report_tenant_variants`, `report_basis_snapshots`, `tenants`, `processed_logs`, `indexer_checkpoints` and `schema_meta`.

### 4.3 Wash-sale lookups (40,200 queries down to 1)

```ts
// BEFORE, core/src/washsale.ts inner loop: one resolver call per (disposition, acquisition) pair
if (classOf(a.token_address) !== sellClass) continue;

// AFTER: each acquisition's class resolved at most once, lazily (identical results)
const acqClass: Array<string | undefined> = new Array(acqs.length);
const classOfAcq = (j: number): string => (acqClass[j] ??= classOf(acqs[j].token_address));
if (classOfAcq(j) !== sellClass) continue;

// AFTER, reports/src/generator.ts: per-report memo, one consistent snapshot of asset_classes
const classByToken = new Map<string, string>();
const analyzer = new WashSaleAnalyzer((token) => {
  let cls = classByToken.get(token);
  if (cls === undefined) {
    cls = getAssetClass?.(chainId, token) ?? token.toLowerCase();
    classByToken.set(token, cls);
  }
  return cls;
});
```

### 4.4 Query de-duplication, `reports/src/db.ts`

Both adapters now call one builder; the SQL text and parameter order are unchanged.

```ts
getUserDispositions(chainId, user, taxYear?, page?, tenantId?) {
  const { sql, params } = buildDispositionsQuery(chainId, user, taxYear, page, tenantId);
  return this.raw.prepare(sql).all(...params) as DispositionRecord[];
}
```

### 4.5 Formatter helper

Four exporters change like this:

```ts
// BEFORE (repeated in each formatter)
const disallowed = BigInt(r.washSaleDisallowed ?? '0');
const reportedGainLoss = BigInt(r.gainLoss) + disallowed;
/* ... */ disallowed > 0n ? 'W' : ''
// AFTER
const { disallowed, reportedGainLoss, code } = washSaleFigures(r);
```

### 4.6 Vault (compiled and tested)

```solidity
function withdraw(uint256 assets, address receiver, address owner) external nonReentrant returns (uint256 shares) {
    if (assets == 0) revert ZeroAmount();
    if (receiver == address(0)) revert ZeroAddress();
    shares = _convertToShares(assets, true);
    _exit(owner, receiver, assets, shares);   // redeem() now ends the same way
}
/// Kept on _approve (not OZ _spendAllowance) so the Approval event and revert behavior are unchanged.
function _exit(address owner, address receiver, uint256 assets, uint256 shares) private { /* former shared tail */ }
```

The Harvester's `getUnrealizedPnL` and `getHarvestableLoss` share a new `_positionValueAndBasis` helper the same way.

### Proposed but not applied (these change behavior and need sign-off)

#### 4.7 C15, `persistReport`

SQLite evaluates the SET expressions against the old row values.

```sql
ON CONFLICT(report_id) DO UPDATE SET
  anchored       = CASE WHEN reports.merkle_root = excluded.merkle_root THEN reports.anchored ELSE 0 END,
  anchor_tx_hash = CASE WHEN reports.merkle_root = excluded.merkle_root THEN reports.anchor_tx_hash ELSE NULL END,
  merkle_root = excluded.merkle_root, report_type = excluded.report_type, file_path = excluded.file_path
```

#### 4.8 C5, reorg-safe source

The indexer calls `getLogs` before its timestamp prefetch, so caching within one iteration still works.

```ts
async getBlockHash(n: number) {          // the reorg check must hit the node, never a cache
  const b = await this.provider.getBlock(n);
  if (!b?.hash) return null;
  if (b.timestamp !== undefined) this.tsCache.set(n, b.timestamp);
  return b.hash;
}
async getLogs(from: number, to: number) { this.tsCache.clear(); /* existing body, no hashCache writes */ }
```

#### 4.9 C12 and C11, frontend

```ts
export const isConfigured = managedTierEnabled ? Boolean(contracts.harvester && contracts.guard) : true;
// HarvestPanel: return buyDecimals from useOracleMinOut, then
formatToken(oracle.minOut, oracle.buyDecimals)   // was v.assetDecimals (the sell token)
```

#### 4.10 C2 and C3

This is a design sketch only; it needs a rule-version bump and CPA review.

```ts
const utcDay = (s: number) => Math.floor(s / 86400);
// Pub. 550: long-term only if sold AFTER the 1-year anniversary date (Feb 29 handling: confirm with a CPA)
export function isLongTermHolding(acquiredAt: number, disposedAt: number): boolean {
  const a = new Date(acquiredAt * 1000);
  const anniversary = Date.UTC(a.getUTCFullYear() + 1, a.getUTCMonth(), a.getUTCDate()) / 1000;
  return utcDay(disposedAt) > utcDay(anniversary);
}
// wash window in calendar days:
if (Math.abs(utcDay(a.acquired_at) - utcDay(sellTime)) > 30) continue;
```

## Open questions (needed before refactoring further)

1. **Calendar days and time zone (C2, C3).** Should these use UTC dates or the taxpayer's local date? Trades near midnight shift the day, and sometimes the tax year. This needs a CPA.
2. **Re-anchoring policy.** `Reporter` locks the first root anchored for a report ID, and the base ID is fixed per (chain, wallet, year). Any root-changing fix (C2 to C9, or a re-index) can't be re-anchored under that ID. `report_versions` exists, but base anchoring doesn't use it. This needs a decision before any of those fixes ship.
3. **Wash-sale basis carryover.** A disallowed loss isn't added to the replacement lot's basis and its holding period isn't tacked on, and no doc mentions this. Without it, the gain on the later sale of the replacement is overstated. Is that intended scope or a gap?
4. **Cross-year replacements.** Each yearly report consumes replacement units from scratch, so one January buy can disallow both a December loss and a January loss.
5. **Form 8949 boxes.** The exports use Box C/F. The newer forms add digital-asset boxes, and whether tokenized securities on an L2 belong there is a question for a tax professional.
6. **Metering.** Should failed requests be billed?
7. **Wash-sale display (C10).** Showing the W-adjusted figure changes a number users see, so it needs product sign-off.

None of this is tax advice. Questions 1 and 3 to 5 need a qualified tax preparer before code changes.

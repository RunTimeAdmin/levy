# Testing

Levy has three automated suites and one live test. Foundry tests cover the contracts, including thirteen fuzzed invariants. Node's built-in test runner covers the keeper (with an integration test against a local anvil chain) and the API. GitHub Actions runs all of them on every pull request and every push to `main`. The live test is the testnet soak: real billing against the deployed contracts. None of this replaces an audit; the contracts are unaudited and run on Arc testnet only.

## Totals

The counts come from the test sources and match the README.

| Suite | Tests | Made up of |
|---|---|---|
| Contracts | 117 | 104 unit tests (53 + 35 + 9 + 7) and 13 invariants |
| Keeper | 97 | 82 unit tests and 15 anvil integration tests |
| API | 83 | 47 endpoint tests and 36 wallet-encoding tests |

The suites test manager v2 ([design](https://github.com/RunTimeAdmin/levy/blob/main/docs/manager-v2-design.md)), which is not deployed yet.

## Contract tests

| File | Tests | Covers |
|---|---|---|
| `test/Levy.t.sol` | 53 | Core behaviour, below |
| `test/ManagerV2.t.sol` | 35 | Merchant accounts, retired plans, cycle limits, intro prices and transfers, below |
| `test/FailureCooldown.t.sol` | 9 | The on-chain dunning schedule against a griefer |
| `test/Deploy.t.sol` | 7 | The deploy script's checks |
| `test/LevyInvariant.t.sol` | 13 invariants | Properties that must hold after any action sequence |
| `test/Terms.sol` | none | `basicTerms`, the plan terms without v2 options that the older tests use |
| `test/mocks/` | none | `MockUSDC` (6 decimals, public `mint`) and `MockPermit2` |

`MockPermit2` implements the real Permit2 EIP-712 scheme and, like the real one, pulls through the owner's ERC-20 approval and refuses a pull once the allowance's expiration has passed, so tests sign genuine permits with `vm.sign`. Amounts are 6-decimal USDC units: `PRICE = 10_000_000` is 10 USDC, and 1 USDC = 1,000,000 units. Tests jump to billing dates with `vm.warp`.

**`Levy.t.sol`** by group: plan creation (4: the stored plan, zero price, the 1-day minimum cycle, a trial longer than the cycle); subscribe (6: trial or not, the merchant reference, no allowance, unknown plan); charge (10: the 99/1 split, charging early, a failure recorded without reverting, PAST_DUE then auto-pause, resume, a `maxFailed` of 200 that once overflowed `uint8`, resume never billing paused cycles, credit surviving a failed pull); back-billing after failures, from the 2026-10-24 review (4: a PAST_DUE recovery pulls one cycle, a recovery starts a fresh cycle, a charge after an outage skips the ended cycles, a late charge keeps the billing date); proration (6: upgrade and downgrade credit, no credit from a trial, no change without a payment, same plan, another merchant's plan); regressions for unbacked credit found in the 2026-09-25 self-review (2); pause, cancel and access (3); merchant resume, from the 2026-10-24 review (4: the merchant cannot resume the subscriber's pause or an auto-pause, can resume its own, and the subscriber can resume the merchant's); fee rounding (1); FeeRouter sweep and the two-step treasury move (2); Permit2 (11: the full flow, a front-run permit with enough allowance, with less than one cycle, with only the intro price on an intro plan and with an expired allowance, only the signer can submit, wrong spender, token or signature, a direct allowance taking priority).

**`ManagerV2.t.sol`** by part of the design: merchant accounts (11: an account owns itself and is paid itself, a fixed payout receives the share and zero follows the owner again, the payout follows a new owner unless fixed, the manager refused as payout, recovery from a blocklisted payout, the two-step handover, only the owner sets the payout, starts a handover or creates plans for the account, and the old key loses its rights); retired plans (4: no new subscribers, no changes into it but changes out, its subscribers keep billing, only the owner retires); cycle limits (6: completion after the last cycle, a one-time payment completing at subscribe, completed is terminal, a plan change restarting the count, a change into a one-cycle plan staying completed, cycles paid from credit counting and the leftover credit forfeited); intro prices and credit (6: the first cycles at the intro price, the intro starting after the trial, the term checks, credit from an intro cycle at the intro price, no intro price surviving plan hopping, and round trips between two plans adding no credit); transfers (8: the move itself, the dunning state moving with it, acceptance naming the plan, only the subscriber proposing, nobody making another wallet pay, plans without transfers refusing them, a withdrawn offer, and no transfer once cancelled).

**`FailureCooldown.t.sol`** turns the external reviews' proofs of concept into regression tests. A second failing `charge()` in the same block or in a looped transaction reverts `RetryTooSoon`. `retryGap` reads 1, 3 and 7 days. Failures land only on days 0, 1, 4 and 11, so a griefer calling daily records four failures and cannot pause before day 11. A top-up inside a gap is collected at once, a success is never held back, resume clears the timer, and a funded subscriber is unaffected. See [Dunning and Failures](Dunning-and-Failures.md).

**`Deploy.t.sol`** places the mocks at the real Arc USDC and Permit2 addresses so the defaults are exercised, and uses `vm.chainId` to switch chain rules. It checks that `run()` wires everything, that USDC or Permit2 without code and a non-6-decimal token revert, that chain 5042 demands a contract treasury and the canonical USDC and Permit2, and that testnet accepts a plain-key treasury. See [Deployment](Deployment.md).

## Invariants and the handler

`LevyInvariantTest` points Foundry at `LevyHandler`, which makes random calls through four actors (the first is the merchant account, acting through whoever owns it now), each minted 1,000,000 USDC. Its fourteen actions are `createPlan` (cycle length 1 to 365 days, `maxFailed` over the full 1 to 255 range, optional trial, and by seed an intro price, a cycle limit of 1 to 4 so one-cycle plans come up, both or neither, and transferability), `subscribe`, `retirePlan` (retire or reopen), `handOver` (the account to another actor), `setPayout` (an actor, a fixed address outside the actors, or zero), `transfer` (a proposal and its acceptance), `grabSubscription` (an acceptance nobody proposed), `approve`, `warpAndCharge` (up to 60 days), `griefCharge` (2 to 4 back-to-back `charge()` calls), `changePlan`, `cancelSub`, `pauseResume` and `sweepFees`. Every call is wrapped in `try/catch`, so one bad call never ends a run. The handler also reads the event logs to total each subscription's `Charged` amounts, to compare every `ChargeFailed` with the previous one and to note completions, and after each successful `charge()` it checks that the subscription is no longer chargeable.

| Invariant | Asserts |
|---|---|
| `conservation` | USDC in the manager, router, treasury, the fixed payout address and the four actors equals total supply |
| `failedAttemptsBounded` | `failedAttempts` is at most 2 x `maxFailed` for every subscription |
| `cancelIsTerminal` | A cancelled subscription stays cancelled and its `chargeCount` never moves |
| `completedIsTerminal` | A completed subscription stays completed and its `chargeCount` never moves |
| `cycleLimitHolds` | `planCycles` never exceeds a limited plan's `maxCycles` |
| `nextChargeMonotonic` | `nextChargeAt` never falls below the subscription's start (it can move earlier on a switch to a shorter-cycle plan) |
| `creditBounded` | Credit never exceeds the largest plan price created |
| `creditBacked` | Credit never exceeds what the subscription has actually paid |
| `failuresSpaced` | No two recorded failures are closer than `retryGap` allows |
| `managerHoldsNothing` | The manager's USDC balance is always 0 |
| `noBackToBackCharges` | A successful `charge()` never leaves its subscription chargeable, so missed cycles are never pulled back to back |
| `retiredPlansGainNothing` | No subscribe or plan change into a retired plan succeeds |
| `subscriberChangesOnlyByAcceptance` | Every subscription's subscriber is the wallet the handler expects, and no acceptance succeeded for a wallet nobody proposed |

`foundry.toml` sets 256 runs at depth 15 by default and 1000 runs at depth 40 under the `ci` profile; the resume bug only showed up past depth 15. There are no stateless fuzz tests, so the invariant suite is the fuzzing. See also [Smart Contracts](Smart-Contracts.md).

## Keeper tests

| File | Tests | Covers |
|---|---|---|
| `webhooks.test.ts` | 36 | Canonical JSON; Ed25519 signing; key loading from file, base64 seed and PEM; the published public key; the 1m, 5m, 15m, 1h, then 6h backoff and the 24 h dead letter; event mapping, including `Completed`, `SubscriptionTransferred` and `merchant.updated` with no subscription fields; fan-out and fairness; live HTTP delivery (signature headers, redirects and private addresses refused, an endless body, parallel endpoints, one request at a time per endpoint, coarse errors, and rows the keeper did not write or that were changed never sent); webhook URL policy |
| `config.test.ts` | 16 | Configuration defaults and refused values, and redacting a key from the RPC URL |
| `dunning.test.ts` | 8 | Retry times of 1, 3 and 7 days, clamping, persistence, and the schedule checked against `retryGap` |
| `dedup.test.ts` | 4 | Collapsing duplicate USDC transfer logs (EIP-7708) |
| `funds.test.ts` | 5 | The allowance runway rule: low when the next two charges are not covered, intro cycles at the intro price, and a limited plan whose remaining charges are covered not low |
| `deployment.test.ts` | 4 | The database tied to one chain, manager and USDC |
| `set-keeper-key.test.ts` | 6 | `ops/set-keeper-key.sh` writing the key line to the keeper-only `ops/keeper.env` (created mode 600) without passing the key as an argument, and naming a key left in `ops/.env` |
| `log-ranges.test.ts` | 2 | Block-range chunking, including a day of Arc blocks in 500-block requests |
| `integration.test.ts` | 14 | The keeper against a real chain |

The live HTTP tests start local servers, so they build the dispatcher with `allowPrivate: true` (the code behind `LEVY_WEBHOOK_ALLOW_PRIVATE`); the private-address test uses the strict setting.

The integration test spawns `anvil --port 8546` (chain 31337), reads its printed dev keys, deploys `MockUSDC`, `FeeRouter`, `MockPermit2` and `SubscriptionManager` from `keeper/abi/*.json` and `.bin`, and builds a `Keeper` over an in-memory database. It sets the log chunk to 7 blocks so every sync crosses chunk boundaries, and moves time with `evm_increaseTime` because the keeper works on chain time. Its fourteen scenarios: a due charge splits 99/1; failures schedule dunning retries; a lost database rebuilds dunning from the chain; a retry after the backoff clears dunning on success; resume clears dunning and charges from now; the database records who paused, since the merchant may resume only its own pause; `Subscribed` and `Charged` enqueue webhooks; charging never waits on webhook delivery; plans nobody subscribed to are indexed and plan changes reported; a charge that reverts backs off; the merchant is warned once when an allowance runs low; only USDC logs involving Levy are indexed; past the sponsored-failure cap a retry waits for funds, then goes through; and the v2 run, which follows intro pricing, a wallet transfer, a completion and merchant account changes into the database and the webhook queue. See [Keeper Service](Keeper-Service.md).

## API tests

`api.test.ts` (44) starts the real Fastify server on an ephemeral port over a seeded temporary SQLite database, with four real keys (a merchant, a subscriber, a second merchant and a former owner that handed its account on) that sign in with genuine EIP-4361 signatures. Groups: `formatUsdc` (1); sign-in (6: message bound to origin and chain, the sign-in and logout round trip, reused nonce, wrong wallet, malformed input, every private endpoint demanding a session); cookie sessions (5: `__Host-` cookie attributes, origin check on writes, logout, the local http variant); public endpoints (6: including a 503 for the public key until the keeper writes it); merchant accounts (4: the accounts an address owns and is offered, an account's data served to its current owner only, webhooks registered under the account for its owner, subscriptions offered to the signed-in wallet); data scoped to the signed-in address (6); webhook management (7: scoping, deliveries, unsafe URLs, an over-long URL, the 5-per-merchant cap, also under concurrent registrations); configuration (5: the `LEVY_PUBLIC_ORIGIN` requirement and format, no keeper secrets, a database from another deployment refused); static pages and their Content-Security-Policy (4). See [Authentication](Authentication.md) and [API Reference](API-Reference.md).

`wallet.test.ts` (35) guards the hand-written browser code in `api/public/wallet.js` against the contract ABIs in `keeper/abi/`: 18 function selectors, the event topics, the getter field order (`subscriptions()` and `plans()`), the `createPlan` encoding of the account and `PlanTerms`, and every v2 transaction encoded exactly as the ABI does. It also prices a plan's first payments (intro cycles at the intro price, none past a cycle limit). It also covers the on-chain plan check the checkout runs before any transaction, the plan-change quote, plain-language wallet errors, exact USDC amounts, the check that the wallet is really on Arc, a missing receipt reported as unknown, reverted transactions, and the faucet and explorer links. See [Dashboard, Portal and Checkout](Dashboard-Portal-and-Checkout.md).

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. The four jobs are independent. A newer push to the same pull request cancels the run in progress; runs on `main` always finish.

```mermaid
flowchart LR
    T["push to main or pull request"] --> C["contracts, 15 min"]
    T --> K["keeper, 15 min"]
    T --> A["api, 15 min"]
    T --> D["docker, 20 min"]
```

| Job | Timeout | What it does |
|---|---|---|
| `contracts` | 15 min | Checks out submodules, installs Foundry, `forge build --sizes`, then `forge test -vvv` with `FOUNDRY_PROFILE=ci`, then the ABI drift check |
| `keeper` | 15 min | Installs Foundry (for anvil) and Node 24, then `npm ci`, `npx tsc --noEmit`, `npm test` |
| `api` | 15 min | Node 24, then `npm ci`, `npx tsc --noEmit`, `npm test` |
| `docker` | 20 min | Builds both images and starts the API container. Checks `/api/health`, `/`, `/public/auth.js`, `/checkout.html` and `/api/config`, that `/api/metrics` answers 401, that the API refuses to start without `LEVY_PUBLIC_ORIGIN` or with `LEVY_KEEPER_KEY`, that compose gives the keeper's secrets and key volume to the keeper alone, and that the keeper image stops with `missing env var LEVY_MANAGER_ADDRESS`. Always prints the API logs. |

The ABI drift check runs `forge inspect <Contract> abi --json` for `FeeRouter`, `MockPermit2`, `MockUSDC` and `SubscriptionManager` and fails if the result differs from `keeper/abi/<Contract>.json`. Those files are regenerated by hand (`forge inspect <Contract> abi --json > keeper/abi/<Contract>.json`, and the bytecode into the matching `.bin`). The check covers the `.json` files only, not the `.bin` files that the integration test deploys. The Docker job exists because the Docker files once broke silently. CI has no coverage report or static-analysis step and never deploys.

## Running the suites locally

```bash
forge build
forge test                            # all contract tests, invariants at 256 x 15
FOUNDRY_PROFILE=ci forge test         # as CI runs it, invariants at 1000 x 40
forge test --match-path test/FailureCooldown.t.sol

cd keeper && npm ci
npx tsc --noEmit                      # typecheck
npm test                              # 97 tests; the integration test needs anvil on PATH
npm run test:integration              # the anvil test alone
node --import tsx --test test/dunning.test.ts   # one file

cd api && npm ci && npx tsc --noEmit && npm test    # 83 tests
```

Node 24 is expected (22.13 or later also works, since `node:sqlite` is built in). Foundry provides `forge` and `anvil`. See [Getting Started](Getting-Started.md) for the full setup.

## Live test: the testnet soak

The soak (`ops/testnet-soak.md`) is the end-to-end test: a week of real billing on Arc testnet against the current deployment, the keeper and the API, started on 2026-10-07. Five subscriber wallets cover the paths: a control left alone, a trial with pause, resume and cancel, a failing allowance that goes through dunning to auto-pause and recovery, an upgrade then a downgrade with proration credit, and a Permit2 subscribe. A separate receiver checks every webhook signature, and `ops/soak-status.sh` produces the daily report ([Monitoring and Maintenance](Monitoring-and-Maintenance.md)). Pass criteria include every due charge collected once within 5 minutes, all ten event types received with valid signatures, on-chain totals matching the database to the unit, and the sweep moving exactly the fees collected. It stops if a subscription is charged twice for one date, USDC goes anywhere but the merchant and the fee router, or a signature fails. Results are in the log at the bottom of that file.

## Source files

- [test/Levy.t.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/Levy.t.sol)
- [test/FailureCooldown.t.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/FailureCooldown.t.sol)
- [test/Deploy.t.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/Deploy.t.sol)
- [test/LevyInvariant.t.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/LevyInvariant.t.sol)
- [test/mocks/MockUSDC.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/mocks/MockUSDC.sol)
- [test/mocks/MockPermit2.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/mocks/MockPermit2.sol)
- [keeper/test/integration.test.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/test/integration.test.ts)
- [keeper/test/webhooks.test.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/test/webhooks.test.ts)
- [api/test/api.test.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/test/api.test.ts)
- [api/test/wallet.test.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/test/wallet.test.ts)
- [.github/workflows/ci.yml](https://github.com/RunTimeAdmin/levy/blob/main/.github/workflows/ci.yml)
- [foundry.toml](https://github.com/RunTimeAdmin/levy/blob/main/foundry.toml)
- [ops/testnet-soak.md](https://github.com/RunTimeAdmin/levy/blob/main/ops/testnet-soak.md)

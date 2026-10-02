# Levy: Subscription Billing on Arc

Pull-based USDC subscription billing for Arc. Merchants define plans, subscribers approve a USDC allowance and subscribe, and a keeper triggers each cycle's pull. The protocol takes a 1% fee on collected payments.

**Status:** contracts, keeper (charging, dunning, webhooks, allowance warnings), API with wallet sign-in, merchant dashboard, customer portal and checkout page are built and tested. Contracts: 61 tests green (53 unit + 8 invariants; CI fuzzes invariants at 1000 runs x depth 40). Keeper: 55 tests green. API: 51 tests green. **Deployed on Arc testnet on 2026-09-26 for the M4 soak (see Deployments). Not on mainnet. Not audited.** Known open issues are listed in `SECURITY_REVIEW.md` §9.

## What's in the repo

| Path | What it is |
|---|---|
| `src/` | Contracts: `SubscriptionManager.sol` (plans, subscriptions, permissionless `charge()`, proration, on-chain dunning state), `FeeRouter.sol` (holds the 1% fee until anyone calls `sweep()`, which sends it to the treasury), `IPermit2.sol` |
| `test/` | Foundry unit and invariant tests, plus the deploy script's tests |
| `script/Deploy.s.sol` | Deploys both contracts to Arc testnet or mainnet, with safety checks |
| `keeper/` | TypeScript service: indexes events, charges due subscriptions, runs dunning, delivers signed webhooks, warns when allowances run low. See `keeper/README.md` |
| `api/` | Fastify API plus the merchant dashboard, customer portal and checkout page. See `api/README.md` |
| `ops/` | Dockerfiles, docker-compose, systemd unit, env example, monitoring runbook, treasury multisig plan, and the testnet soak checklist (`testnet-soak.md`) with its tools |
| `docs/` | Merchant guide and dunning email copy |
| `site/` | Static landing page and whitepaper (`whitepaper.html`, with a PDF built from it) |
| `SPEC.md`, `SECURITY_REVIEW.md`, `FEE_MATH_AUDIT.md`, `VERIFICATION.md` | Design spec, adversarial self-review, math audit, verified Arc facts |

## How charging works

1. A merchant calls `createPlan(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed)` from their wallet, most simply through the dashboard's New plan form. The cycle can be 1 day to 10 years. Price is immutable; repricing means a new plan.
2. A subscriber approves a USDC allowance to the SubscriptionManager and calls `subscribe(planId, ref)`, or calls `subscribeWithPermit2(planId, ref, permit, signature)` with a Permit2 signature (submitted by the subscriber themselves). The checkout page (`/checkout.html?plan=<id>&ref=<ref>`) does the approve-and-subscribe flow for them. Billing is in advance: without a trial, the first cycle is pulled at subscribe, and the subscribe reverts if that pull fails. `ref` is the merchant's own reference for the customer (bytes32, zero for none), stored on-chain and carried on every webhook.
3. Anyone can call `charge(subId)` once `block.timestamp >= nextChargeAt`; it pays for the cycle that starts then. The contract spends any proration credit first, pulls the rest via `transferFrom`, sends 99% to the merchant and 1% to the FeeRouter, advances the cycle and emits `Charged`. It is permissionless by design: it can only move the subscriber's pre-approved funds to that plan's merchant.
4. A failed pull does not revert: the contract records it (`ChargeFailed`), marks the subscription `PAST_DUE` at `maxFailed` failures, and auto-pauses it at twice that. It records at most one failure per subscription per day (`MIN_RETRY_INTERVAL`); a failing call sooner reverts `RetryTooSoon`, so nobody can rush a subscription to paused by calling `charge()` repeatedly. The keeper retries 1, 3 and then 7 days after each failure (then every 7 days).
5. The subscriber or merchant can pause, resume or cancel. Nothing is charged while paused; resuming is a fresh start (paused cycles are never billed, billing restarts at the resume if the charge date passed, and the failure count resets). Cancel is final.
6. A subscriber can change to another plan from the same merchant: the new plan starts and is billed immediately, less credit for unused paid time on the old plan.

### Money math

- All amounts are 6-decimal USDC units through the ERC-20 interface (`0x3600...0000`). Native 18-decimal values never enter payment logic.
- Integer arithmetic only. The fee is `amount / 100`, rounded down, so any rounding (under one unit) goes to the merchant.
- Credit only comes from a paid cycle (trial time earns none), is added to existing credit, and is spent before any pull. Excess carries forward and survives failed pulls.

### Invariants (fuzz-tested)

- Conservation: every minted unit sits in exactly one tracked account.
- `failedAttempts <= 2 * maxFailed` for every subscription.
- Recorded failures are at least a day apart, even with a griefer calling `charge()` repeatedly.
- Cancel is terminal: `chargeCount` never moves after cancellation.
- `nextChargeAt` never falls below the subscription's start. (It can move earlier on a switch to a shorter-cycle plan, which bills the new cycle immediately.)
- Credit is backed: a subscription never holds more credit than the USDC it has paid.
- Credit never exceeds the largest plan price.
- The manager holds no funds at rest: every pull is fully split in the same transaction.

## Off-chain services

**Keeper** (`keeper/`, viem + SQLite). Two independent loops: charge cycles (every 30s) and webhook delivery (every 5s), so a slow merchant endpoint can never delay charging. Each charge cycle syncs events (chunked, and only Levy's own logs plus USDC transfers into or out of the manager), charges due subscriptions, runs dunning retries, backs off charges that revert, and checks subscribers' allowance runway. Webhooks are Ed25519-signed over timestamp, delivery id and body, delivered in parallel, retried with backoff and dead-lettered after 24h. Ten event types, including `allowance.low` when a subscriber's allowance covers fewer than 2 more rounds of their subscriptions.

**API** (`api/`, Fastify). Merchants and subscribers sign in with their wallet (Sign-In with Ethereum, 24h sessions) and only ever see their own data. It serves:

- the merchant dashboard (`/`): metrics, plans with their checkout links and a New plan form, subscriptions with references and allowance runway (each can be paused, resumed or cancelled), dunning queue, webhooks with their delivery log, invoice CSV;
- the customer portal (`/portal.html`): subscriptions and invoices; pause, resume, cancel and plan changes from the wallet; and the Levy allowance, with a top-up and a revoke;
- the checkout page (`/checkout.html?plan=<id>&ref=<ref>`).

Webhook URLs must be https on port 443 at a public address (checked at registration and again at every delivery). The merchant guide (`docs/merchant-guide.md`) covers plans, webhooks and signature verification, checkout links and references, and dunning.

## Development

Requires [Foundry](https://getfoundry.sh/) for the contracts and Node 24 for the keeper and API.

```bash
forge build
forge test
FOUNDRY_PROFILE=ci forge test        # deeper invariant fuzzing, as CI runs it
cd keeper && npm install && npm test # unit tests + anvil integration test (needs anvil on PATH)
cd api && npm install && npm test
```

CI (`.github/workflows/ci.yml`) runs the contract tests, the keeper and API typechecks and tests, fails if `keeper/abi/*.json` no longer matches the contracts, and builds both Docker images, then starts the API container to check that it serves the pages and enforces sign-in. After changing a contract, regenerate with `forge inspect <Contract> abi --json > keeper/abi/<Contract>.json` (and `bytecode` into the `.bin`).

`foundry.toml` pins `evm_version = "paris"`. Arc mainnet runs an Osaka EVM, so this is not required; paris stays as a harmless conservative default (see `VERIFICATION.md` §2).

## Deploy

`script/Deploy.s.sol` deploys FeeRouter and SubscriptionManager and prints the `.env` lines the keeper and API need (the API passes the addresses to the checkout page via `/api/config`). It refuses to deploy unless USDC and Permit2 have code at their addresses and USDC reports 6 decimals, and on mainnet unless the treasury is a contract (the Safe from `ops/treasury-multisig.md`).

```bash
export DEPLOYER_PRIVATE_KEY=0x...   # pays gas in USDC; testnet USDC from https://faucet.circle.com
export LEVY_TREASURY=0x...          # FeeRouter treasury
forge script script/Deploy.s.sol --rpc-url arc_testnet             # simulate
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast # deploy
```

On Windows, `script/deploy-testnet.ps1` does the testnet broadcast for you: it asks for the deployer's key without echoing it, checks that the key belongs to the address you give and that the wallet holds enough USDC, and clears the key when forge exits.

Use `--rpc-url arc_mainnet` for mainnet, and add `--legacy` if fee estimation fails. `LEVY_USDC` and `LEVY_PERMIT2` override the Arc defaults. The testnet deploy used 3.65M gas at 32.5 gwei, about 0.12 USDC (2026-09-26). Broadcast records land in `broadcast/`; commit the testnet and mainnet ones as the deployment record. If the keeper first starts more than `LEVY_LOOKBACK_BLOCKS` (default 5000, about 40 minutes) after the deploy, raise it to reach back to the deploy block.

To run the keeper and API: `docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build` (copy `ops/.env.example` first; `LEVY_PUBLIC_ORIGIN` is required). The API is published on the host's loopback only; put a TLS reverse proxy in front (`ops/nginx-app.conf.example` is the nginx site the testnet host uses). `ops/keeper.service` is the systemd alternative for the keeper.

## Deployments

**Arc testnet** (chain 5042002), deployed 2026-09-26 in block 64031023, with the fix for H-1 (`SECURITY_REVIEW.md` §9). The record is `broadcast/Deploy.s.sol/5042002/run-1790390636694.json` (also `run-latest.json`).

| Contract | Address | Transaction |
|---|---|---|
| SubscriptionManager | `0x33c8e7e46583bdfd2e001f55ac1c58bd84eb739f` | `0x5c273208a2f72874936f2bfb1e0d7247e01148c2c4fb08db809deae81d4c07fe` |
| FeeRouter | `0xa6efee5f5a2eb2afae102f790b4889fcc01fe848` | `0x30295b52c2bfb961cc886f5335c1c54dd420b683ed811b93d5b17812fba64388` |

- Deployer and treasury: `0xe305652DB35Ed45A567538438c9B29ede7097162` (testnet only; mainnet uses the Safe).
- Code: the on-chain runtime bytecode of both contracts matches a local build of the contract sources at `08dd7b7` byte for byte, outside the constructor-set immutables (the build metadata, which hashes the sources, matches too). The record's `commit` field says `58ed3ba` because forge was run before the fix was committed. Source is not yet verified on the explorer.
- Soak host: keeper and API at `https://app.getlevy.xyz`.
- **Superseded:** the first deployment the same day, in block 64020204 (SubscriptionManager `0x9df75ab83bde215f773af982af95b00646318189`, FeeRouter `0x79c6bb4030c688e64efdd2d33f0178e63fdf0b9f`, record `run-1790385119083.json`), predates the H-1 fix. It was never used for billing and nothing points at it.

## Arc facts (verified 2026-09-25, see `VERIFICATION.md`)

- Mainnet chain ID 5042 (`https://rpc.mainnet.arc.io`), testnet 5042002 (`https://rpc.testnet.arc.io`). USDC is the gas token.
- Single-block deterministic finality (~0.5s blocks, Malachite BFT, no reorgs), so the keeper treats a mined transaction as final.
- Osaka-baseline EVM (PUSH0 works).
- Permit2 at the canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`, same as Ethereum.
- Transaction memos are live on mainnet (Memo contract `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`); Levy does not use them yet.

## Before mainnet

- A soak of at least a week on the testnet deployment (M4; deployed 2026-09-26). Checklist and pass criteria: `ops/testnet-soak.md`.
- Treasury multisig signers set (`ops/treasury-multisig.md`).
- Permit2 end to end against Arc (tested against a mock only so far).
- Open items in `SECURITY_REVIEW.md` §9, and an external audit.
- Thin-liquidity note for launch comms.

## Roadmap

- **M1:** contracts + tests (done; testnet deploy moves to M4)
- **M2:** keeper service, indexer, dunning engine (done)
- **M3:** signed webhooks, API, merchant dashboard, customer portal, checkout, invoicing (done)
- **M4:** testnet deploy (done 2026-09-26) and soak, then mainnet deploy
- **M5:** LEVY token: fee split to buyback-and-burn and staking, staking fee-tier discounts, premium feature gating

## License

MIT, see [LICENSE](LICENSE).

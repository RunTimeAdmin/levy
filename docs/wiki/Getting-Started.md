# Getting Started

This page takes a fresh clone to a working Levy stack on your own machine: contracts built and tested, a local chain running, the keeper and API started against it, a plan created, a subscription made and a charge collected. Nothing here touches Arc testnet or mainnet, and no real funds are involved. For a real deployment see [Deployment](Deployment.md); for how the pieces fit together see [Architecture](Architecture.md).

Commands use bash syntax (Git Bash, WSL, macOS, Linux). In PowerShell, set variables with `$RPC = "..."` and `$env:NAME = "..."`.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Git | any | clone, submodules |
| [Foundry](https://getfoundry.sh/) (`forge`, `cast`, `anvil`) | current stable | build and test the contracts, run a local chain, run the keeper's integration test |
| Node.js | 24 (22.13 or later also works) | keeper and API; both use the built-in `node:sqlite` |
| Browser wallet (MetaMask or any EIP-1193 wallet) | any | the dashboard, portal and checkout sign in and send transactions through it |
| Docker | optional | the production-style stack in `ops/docker-compose.yml` |

`foundry.toml` does not pin a compiler: forge picks a solc that satisfies `pragma ^0.8.20`. The testnet deployment was built with solc 0.8.33.

## Clone with submodules

The contracts depend on two git submodules, `lib/forge-std` and `lib/openzeppelin-contracts`. The keeper and the API are separate npm packages with their own lockfiles; there is no root `package.json`.

```bash
git clone --recurse-submodules https://github.com/RunTimeAdmin/levy.git
cd levy
git submodule update --init --recursive   # only if you cloned without --recurse-submodules
```

The repository is private, so cloning needs read access.

## Build and test the contracts

```bash
forge build
forge test                       # 65 tests: 57 unit, 8 invariants (256 runs x depth 15)
FOUNDRY_PROFILE=ci forge test    # what CI runs: invariants at 1000 runs x depth 40
```

In PowerShell use `$env:FOUNDRY_PROFILE = "ci"; forge test`. After changing a contract, regenerate the keeper's copy of its ABI and bytecode (the integration test deploys from the `.bin`), because CI fails when `keeper/abi/*.json` is stale:

```bash
forge inspect SubscriptionManager abi --json > keeper/abi/SubscriptionManager.json
forge inspect SubscriptionManager bytecode > keeper/abi/SubscriptionManager.bin
```

## Test the keeper and the API

```bash
cd keeper && npm ci && npm test      # 55 tests; includes an integration test that spawns anvil
npx tsc --noEmit                     # typecheck, as CI does
cd ../api && npm ci && npm test      # 55 tests; seeded temp database, ephemeral port
```

`npm ci` installs exactly the lockfile, as CI does; `npm install` also works. The keeper's integration test needs `anvil` on your PATH and uses its own anvil on port 8546. `npm run test:integration` runs it alone. See [Testing](Testing.md).

## Run a local chain and deploy

Start anvil in its own terminal:

```bash
anvil
```

It listens on `http://127.0.0.1:8545` with chain ID 31337 and prints ten funded accounts with their private keys. These keys are public dev keys: use them only here. This guide uses account (0) as merchant, deployer and treasury, account (1) as the keeper, and account (2) as the subscriber.

A fresh anvil has no USDC and no Permit2, and `script/Deploy.s.sol` refuses to deploy unless both have code at their Arc addresses. Place the test mocks there:

```bash
RPC=http://127.0.0.1:8545
cast rpc anvil_setCode 0x3600000000000000000000000000000000000000 "$(forge inspect MockUSDC deployedBytecode)" --rpc-url $RPC
cast rpc anvil_setCode 0x000000000022D473030F116dDEE9F6B43aC78BA3 "$(forge inspect MockPermit2 deployedBytecode)" --rpc-url $RPC
```

`MockUSDC` is a 6-decimal ERC-20 with an open `mint`. Amounts in Levy are integers in 6-decimal USDC units: 1 USDC = 1,000,000, so 10 USDC is 10000000.

Deploy:

```bash
export DEPLOYER_PRIVATE_KEY=0x...   # anvil account (0) private key
export LEVY_TREASURY=0x...          # anvil account (0) address
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
```

The script prints the FeeRouter address, the deploy block and three `.env` lines (`LEVY_CHAIN_ID`, `LEVY_MANAGER_ADDRESS`, `LEVY_USDC_ADDRESS`). Keep them for the next step. The run also writes `broadcast/Deploy.s.sol/31337/`; do not commit it, because that folder is the deployment record for real chains.

## Configure the keeper and the API

Each service reads a `.env` file in its own folder (`npm start` loads it with `node --env-file-if-exists=.env`).

```bash
cp keeper/.env.example keeper/.env
cp api/.env.example api/.env
```

The example files default to Arc mainnet. For a local run set these (a few already match):

| Variable | Used by | Local value |
|---|---|---|
| `LEVY_RPC_URL` | keeper | `http://127.0.0.1:8545` (the code's default when unset) |
| `LEVY_CHAIN_ID` | keeper, API | `31337` |
| `LEVY_MANAGER_ADDRESS` | keeper, API | the address the deploy printed |
| `LEVY_USDC_ADDRESS` | keeper, API | `0x3600000000000000000000000000000000000000` |
| `LEVY_KEEPER_KEY` | keeper | anvil account (1) private key; it pays gas |
| `LEVY_DB_PATH` | keeper, API | keep the defaults: `./levy.db` for the keeper, `../keeper/levy.db` for the API (one shared file) |
| `LEVY_WEBHOOK_KEY_PATH` | keeper, API | keep the defaults; both must point at the same key file, which the keeper creates on first boot |
| `LEVY_PUBLIC_ORIGIN` | API | `http://localhost:3001`; sign-in messages and the write-origin check are bound to it exactly |
| `LEVY_WEBHOOK_ALLOW_PRIVATE` | keeper, API | optional, `1`: allows `http` and private-address webhook URLs. Local development only |

The API has no RPC URL and no key: it reads the keeper's database. Tuning variables (`LEVY_POLL_MS`, `LEVY_DUNNING_DAYS`, `LEVY_LOOKBACK_BLOCKS`, `LEVY_LOG_CHUNK_BLOCKS`, `LEVY_WEBHOOK_POLL_MS`) are covered in [Keeper Configuration](Keeper-Configuration.md).

## Start the keeper and the API

In two more terminals, keeper first so the database and signing key exist:

```bash
cd keeper && npm start    # charge loop every 30 s, webhook delivery loop every 5 s
cd api && npm start       # http://127.0.0.1:3001
```

The keeper logs `levy keeper: chain=31337 manager=... keeper=...` and `backfilled 0 subscriptions`, then logs only cycles in which something happened. Node prints an `ExperimentalWarning` for `node:sqlite`; ignore it. `npm run once` runs a single charge cycle and delivery pass and exits. Check the API:

```bash
curl http://127.0.0.1:3001/api/health    # {"ok":true,"service":"levy-api","version":"0.1.0"}
```

## Create a plan and subscribe

1. **Wallet.** Add a network with RPC `http://127.0.0.1:8545`, chain ID 31337 and symbol ETH. The pages only add the two Arc networks automatically; on any other chain they ask you to switch yourself. Import anvil accounts (0) and (2).
2. **Test USDC.** Give the subscriber 100 USDC (`100000000` units) with the mock's `mint`:
   ```bash
   cast send 0x3600000000000000000000000000000000000000 "mint(address,uint256)" <account-2-address> 100000000 --rpc-url $RPC --private-key <account-0-key>
   ```
3. **Dashboard.** Open exactly `http://localhost:3001` (not `127.0.0.1`: the origin must match `LEVY_PUBLIC_ORIGIN`). Sign in as account (0); the signature is free and sends no transaction.
4. **New plan.** Under Plans choose New plan: price 10, billing cycle Daily (the shortest, so one warped day is enough later), trial 0, failed payments before past due 3, then confirm in the wallet. The plan appears once the keeper has indexed it, within about 30 seconds. Copy its checkout link, `http://localhost:3001/checkout.html?plan=1`; you can append `&ref=customer-42` (up to 31 ASCII characters) to tag the customer.
5. **Checkout.** Switch the wallet to account (2), open the link, connect, pick how many cycles to approve (default 12) and choose Approve and subscribe: two wallet confirmations. With no trial, the first cycle is charged at once.
6. **Portal.** `http://localhost:3001/portal.html` shows the subscription, its invoices and the allowance, and lets the subscriber pause, resume, cancel or change plan.

Read the account address in the page header before each action. The wallet only offers accounts the site is connected to, so the signed-in address may not be the account you expect.

Without a browser wallet, the same flow runs from the command line (`$MGR` is the manager address, `$USDC` the USDC address). `createPlan` takes price, cycleSeconds, trialSeconds, graceSeconds (unused, send 0) and maxFailed.

```bash
cast send $MGR "createPlan(uint256,uint256,uint256,uint256,uint8)" 10000000 86400 0 0 3 --rpc-url $RPC --private-key <account-0-key>
cast send $USDC "approve(address,uint256)" $MGR 120000000 --rpc-url $RPC --private-key <account-2-key>
cast send $MGR "subscribe(uint256,bytes32)" 1 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url $RPC --private-key <account-2-key>
```

## Watch a charge happen

The keeper works on chain time, so move anvil's clock past the next charge date:

```bash
cast rpc evm_increaseTime 86400 --rpc-url $RPC   # one day, the shortest cycle
cast rpc evm_mine --rpc-url $RPC
```

Within one charge cycle the keeper logs `[cycle] charged=1 ...`. A 10 USDC plan then pays 9.9 USDC to the merchant and 0.1 USDC to the FeeRouter per charge; anyone can call `sweep()` on the FeeRouter to forward the fees to the treasury. To see delivery, register a webhook (dashboard, Webhooks) pointing at a local receiver, with `LEVY_WEBHOOK_ALLOW_PRIVATE=1` set on both services.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Keeper exits with `missing env var LEVY_MANAGER_ADDRESS` | no `keeper/.env`, or the value is empty |
| Checkout says it is not configured | the API's manager or USDC address is unset or the zero placeholder |
| Checkout says `Plan #1 was not found` | the keeper is not running or has not synced yet; plans come from its index |
| Wallet asks you to switch to chain 31337 | add the anvil network to the wallet |
| Sign-in warns about the domain, or writes return 403 | the page was opened at an origin other than `LEVY_PUBLIC_ORIGIN` |

## Source files

- [foundry.toml](https://github.com/RunTimeAdmin/levy/blob/main/foundry.toml)
- [script/Deploy.s.sol](https://github.com/RunTimeAdmin/levy/blob/main/script/Deploy.s.sol)
- [keeper/package.json](https://github.com/RunTimeAdmin/levy/blob/main/keeper/package.json)
- [keeper/.env.example](https://github.com/RunTimeAdmin/levy/blob/main/keeper/.env.example)
- [api/package.json](https://github.com/RunTimeAdmin/levy/blob/main/api/package.json)
- [api/.env.example](https://github.com/RunTimeAdmin/levy/blob/main/api/.env.example)
- [README.md](https://github.com/RunTimeAdmin/levy/blob/main/README.md)
- [.github/workflows/ci.yml](https://github.com/RunTimeAdmin/levy/blob/main/.github/workflows/ci.yml)

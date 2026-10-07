# Keeper Configuration

The keeper and the API are configured entirely through environment variables. There is no config file format. `keeper/src/config.ts` reads the keeper's variables once at startup, and `api/src/server.ts` reads the API's. This page lists every variable, how the keeper's keys are handled, how to run it, and what it logs.

## Keeper variables

| Variable | Required | Default | Meaning | Example |
|---|---|---|---|---|
| `LEVY_RPC_URL` | no | `http://127.0.0.1:8545` | JSON-RPC endpoint for reads, log queries and charge transactions. The default is a local anvil node. | `https://rpc.testnet.arc.io` |
| `LEVY_CHAIN_ID` | no | `5042` (Arc mainnet) | Chain id the keeper signs for. Set `5042002` for Arc testnet. | `5042002` |
| `LEVY_MANAGER_ADDRESS` | yes | none | The SubscriptionManager contract. | `0x62a6512335d630ef19fcadb497adf98d883f77c6` (testnet) |
| `LEVY_USDC_ADDRESS` | yes | none | USDC ERC-20 interface (6 decimals). Used for allowance and balance reads and for log filters. | `0x3600000000000000000000000000000000000000` |
| `LEVY_KEEPER_KEY` | yes | none | Private key of the keeper account, `0x` plus 64 hex digits. | from your secret store |
| `LEVY_POLL_MS` | no | `30000` | Pause between charge cycles, in ms. | `30000` |
| `LEVY_WEBHOOK_POLL_MS` | no | `5000` | Pause between webhook delivery passes, in ms. | `5000` |
| `LEVY_DUNNING_DAYS` | no | `1,3,7` | Days to wait before retry N after the Nth failure; later failures reuse the last value. Cannot beat the on-chain gaps (see below). | `1,3,7` |
| `LEVY_DB_PATH` | no | `./levy.db` | SQLite file, relative to the working directory. | `/data/levy.db` |
| `LEVY_LOOKBACK_BLOCKS` | no | `5000` | How far back the first sync scans when no cursor exists (about 40 minutes). | `100000` |
| `LEVY_LOG_CHUNK_BLOCKS` | no | `500` | Blocks per `eth_getLogs` request. Keep it under your RPC provider's range cap. | `500` |
| `LEVY_WEBHOOK_KEY_PATH` | no | `./webhook-signing-key.pem` | File holding the Ed25519 webhook signing key. Created on first boot if missing. | `/data/webhook-signing-key.pem` |
| `LEVY_WEBHOOK_KEY` | no | unset | Inline signing key: PEM PKCS#8 or a base64 32-byte seed. Wins over the file. | from your secret store |
| `LEVY_WEBHOOK_ALLOW_PRIVATE` | no | off | `1` allows http, any port and private addresses for webhooks. Local development only. | `1` |

A missing required variable stops the keeper at startup with `missing env var <name>`.

For Arc testnet, the public values are:

```bash
LEVY_RPC_URL=https://rpc.testnet.arc.io
LEVY_CHAIN_ID=5042002
LEVY_MANAGER_ADDRESS=0x62a6512335d630ef19fcadb497adf98d883f77c6
LEVY_USDC_ADDRESS=0x3600000000000000000000000000000000000000
LEVY_KEEPER_KEY=0x<64 hex digits>
```

Levy runs on Arc testnet only. Nothing is deployed on mainnet.

### Parsing rules

- Nothing is validated. Numbers go through `Number(...)`, so a typo becomes `NaN` instead of an error.
- `LEVY_WEBHOOK_ALLOW_PRIVATE` is on only when the value is exactly `1`.
- `LEVY_DUNNING_DAYS` is split on commas. The contract enforces minimum gaps between recorded failures through `retryGap`: 1 day after the first, 3 after the second, 7 after each later one. A shorter configured gap makes the retry revert with `RetryTooSoon`, and the keeper then treats it as an error and backs off. Longer gaps work.
- `npm start` and `npm run once` load a `.env` file from the working directory if one exists. A variable already set in the real environment takes precedence over the file.

## API variables

The API reads some of the same variables. Where the name matches, the meaning is the same, but several defaults differ.

| Variable | Default in the API | Notes |
|---|---|---|
| `LEVY_API_PORT` | `3001` | Listen port. In Docker the container always uses 3001 and this variable only picks the host port. |
| `LEVY_API_HOST` | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0` and compose publishes the port on the host's loopback only. |
| `LEVY_PUBLIC_ORIGIN` | `http://localhost:<port>` | Origin the pages are served from; sign-in messages and cookie checks are bound to it. **Required when `NODE_ENV=production`**, otherwise startup throws. |
| `NODE_ENV` | unset | The API image sets `production`. |
| `LEVY_DB_PATH` | `keeper/levy.db` in the repo | Must point at the keeper's file. |
| `LEVY_WEBHOOK_KEY_PATH` | `keeper/webhook-signing-key.pem` in the repo | Must be the keeper's key file. |
| `LEVY_WEBHOOK_KEY` | unset | Inline key, same format as the keeper's. |
| `LEVY_CHAIN_ID` | `5042` | Goes into sign-in messages and `GET /api/config`. |
| `LEVY_WEBHOOK_ALLOW_PRIVATE` | off | Relaxes the URL check at registration. |
| `LEVY_MANAGER_ADDRESS`, `LEVY_USDC_ADDRESS` | unset | Optional here. `GET /api/config` hands them to the checkout page; unset or the zero address means "checkout not configured". |

The API never reads `LEVY_KEEPER_KEY`. See [Authentication](Authentication.md) and [API Reference](API-Reference.md).

`ops/soak/status.mjs` and `ops/soak/webhook-receiver.mjs` are testnet soak tools that read their own extra variables (`LEVY_ABI_DIR`, `PORT`, `PUBLIC_KEY_URL`, `LOG_PATH`). They are not part of the keeper.

## Keys

**Keeper account (`LEVY_KEEPER_KEY`).** A hot externally owned account that signs `charge()` transactions and pays gas in USDC. The contract gives it no role, since `charge()` is permissionless, so the key's only value is its gas balance. Fund it minimally and watch the balance ([Monitoring and Maintenance](Monitoring-and-Maintenance.md)). If the key is exposed, switch to a new account and restart; no contract change is needed. The keeper prints the account's address at boot and never logs the key. Never commit it: Docker reads it from the untracked `ops/.env` (`ops/set-keeper-key.sh` writes it there without echoing it), and systemd reads it from a root-owned `keeper.env` with mode 600.

**Webhook signing key.** A separate Ed25519 key, loaded in this order:

1. `LEVY_WEBHOOK_KEY`, if set.
2. The file at `LEVY_WEBHOOK_KEY_PATH`.
3. If that file does not exist, the keeper generates a keypair and saves it there with mode 0600. Any other read error stops the keeper.

The API serves the matching public key at `GET /api/webhooks/public-key`, so it must load the same key: the same file path (in Docker both containers share one volume) or the same `LEVY_WEBHOOK_KEY`. If the API finds no key file at its own path it creates a fresh one, and when that path differs from the keeper's, every merchant's signature check fails. Back up the key file. A new key changes `X-Levy-Key-Id`, and merchants must fetch the new public key ([Webhooks](Webhooks.md)).

## Running the keeper

It needs Node 24 (22.13 or later works), because the database is the built-in `node:sqlite`.

```bash
cd keeper
npm install
cp .env.example .env    # fill in the addresses and the keeper key
npm start               # both loops, until SIGINT or SIGTERM
npm run once            # one charge cycle and one delivery pass, then exit
```

`npm run once` is the quick way to check a configuration: it indexes, charges anything due and exits. For production, compile with `npx tsc` and run `node dist/index.js` under Docker (`ops/Dockerfile.keeper`, `ops/docker-compose.yml`) or systemd (`ops/keeper.service`). Compose forces `LEVY_DB_PATH` and `LEVY_WEBHOOK_KEY_PATH` onto the shared `/data` volume whatever the env file says. See [Deployment](Deployment.md).

## Logging

The keeper has no logging framework, no levels and no log variable. It writes plain lines with `console.log` (stdout) and `console.error` (stderr), and the container runtime or journald adds timestamps. Compose rotates the Docker logs at 50 MB across 5 files.

| Line | Stream | When |
|---|---|---|
| `levy keeper: chain=<id> manager=<addr> keeper=<addr>` | stdout | Startup |
| `webhook signing key: <path> (public key at GET /api/webhooks/public-key)` | stdout | Startup |
| `backfilled <n> subscriptions` | stdout | Startup |
| `[cycle] charged=N retried=N failed=N logs=N` | stdout | Only when the cycle charged, retried or failed something |
| `  ! sub <id>: <error>` | stdout | One per failed charge in that cycle |
| `[cycle] error: <message>` | stderr | The cycle threw, for example an RPC or database error |
| `[webhooks] sent=N failed=N dead=N` | stdout | Only when the pass sent, failed or dead-lettered something |
| `[webhooks] error: <message>` | stderr | The delivery pass threw |
| Error and stack trace | stderr | Fatal startup failure, then exit code 1 |

A quiet cycle prints nothing, so silence from a running process is normal. A `! sub <id>: ChargeFailed` line is also normal: it is a payment failure that dunning now owns. Other error text means a revert or RPC problem and starts the error backoff ([Keeper Service](Keeper-Service.md)). The API logs one startup line (`levy api listening on ...`) and has Fastify's request logging switched off.

## Source files

- [keeper/src/config.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/config.ts)
- [keeper/src/index.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/index.ts)
- [keeper/src/webhooks.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhooks.ts)
- [keeper/package.json](https://github.com/RunTimeAdmin/levy/blob/main/keeper/package.json)
- [api/src/server.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/server.ts)
- [ops/docker-compose.yml](https://github.com/RunTimeAdmin/levy/blob/main/ops/docker-compose.yml)
- [ops/keeper.service](https://github.com/RunTimeAdmin/levy/blob/main/ops/keeper.service)
- [ops/set-keeper-key.sh](https://github.com/RunTimeAdmin/levy/blob/main/ops/set-keeper-key.sh)

# Levy API + Pages

Fastify API over the keeper's SQLite database, plus the merchant dashboard,
customer portal and checkout page. The API never holds keys or signs
transactions: on-chain writes (plan creation, subscribe, pause, resume,
cancel, allowance changes) are signed in the user's wallet, and the pages
build those transactions in the browser.

## Run

Requires Node 24 (the API imports the keeper's `src/db.ts`, which uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # point LEVY_DB_PATH at the keeper's DB
npm start              # loads .env if present; http://127.0.0.1:3001
```

For production use the Docker image (see Deploying); it is compiled with `tsc`.

## Pages

- `/`: merchant dashboard. Metrics, subscriptions (with the merchant's reference and each subscriber's allowance runway), dunning queue, webhooks, invoice CSV.
- `/portal.html`: customer portal. Subscriptions and invoice history; pause, resume and cancel from the wallet; an allowance top-up when it runs low.
- `/checkout.html?plan=<planId>&ref=<reference>`: where a customer subscribes. It shows the plan, adds 12 cycles (adjustable, 1 to 120) to the customer's USDC allowance for Levy, and calls `subscribe`. `ref` is optional: `0x` plus 64 hex digits, or up to 31 ASCII characters (see the merchant guide). Needs `LEVY_MANAGER_ADDRESS` and `LEVY_USDC_ADDRESS` set for the API.

The dashboard and portal sign in with a browser wallet. The pages load no
third-party code; their contract calls are encoded in `public/wallet.js`, checked
against the ABI by `test/wallet.test.ts`.

## Sign-in

Sign-In with Ethereum (EIP-4361), EOA wallets only for now:

1. `POST /api/auth/challenge {address}` returns `{nonce, message}`. The server
   writes the whole message, bound to `LEVY_PUBLIC_ORIGIN` and `LEVY_CHAIN_ID`.
   It expires after 5 minutes.
2. The wallet signs `message` (`personal_sign`).
3. `POST /api/auth/verify {nonce, signature}` returns `{token, address, expiresAt}`.
   Each challenge works once, even when the signature is wrong.
4. Send `Authorization: Bearer <token>` on every other call. Tokens last 24h and
   only their SHA-256 is stored. `GET /api/auth/session` checks one,
   `POST /api/auth/logout` revokes it.

Set `LEVY_PUBLIC_ORIGIN` to the exact origin the pages are served from
(e.g. `https://app.getlevy.xyz`). Wallets warn when the page's domain differs
from the message's, and the server never takes the domain from the request.

## Endpoints

Everything except health, config, plans, the webhook public key and the
sign-in routes needs a session, and only returns the signed-in address's own
data: as merchant (dashboard) or as subscriber (portal). An address param
naming someone else gets 403; another merchant's webhook or subscription id
gets 404.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | public | liveness |
| GET | `/api/config` | public | chain id and contract addresses, for the checkout page and portal |
| GET | `/api/plans` | public | every on-chain plan (read-only mirror, including plans with no subscribers) |
| GET | `/api/webhooks/public-key` | public | Ed25519 SPKI PEM and its `keyId`, plus the event list |
| POST | `/api/auth/challenge`, `/api/auth/verify` | public | sign-in (above) |
| GET | `/api/auth/session`, POST `/api/auth/logout` | session | check or revoke the session |
| GET | `/api/subscriptions?merchant=\|subscriber=&status=` | session | one of merchant/subscriber, equal to the session; `status` is numeric (0 trial, 1 active, 2 past_due, 3 paused, 4 cancelled); rows include `ref`, `fundsLow`, `cyclesCovered` |
| GET | `/api/subscriptions/:id` | session | + charges, dunning row; subscriber or merchant only |
| GET | `/api/funds` | session | the subscriber's allowance runway as of the keeper's last check (`low`, `cyclesCovered`, allowance, balance) |
| GET | `/api/metrics` | session | as merchant: MRR (trial + active, normalized to 30 days), counts per status, totals, charge success rate, dunning depth |
| GET | `/api/dunning` | session | as merchant: retry queue with nextRetryAt |
| GET | `/api/charges?subscription=` | session | as merchant: charge records |
| GET | `/api/invoices?format=csv` | session | alias of charges; `format=csv` downloads CSV |
| GET/POST | `/api/webhooks` | session | list / register `{url, events[]}` (at most 5 per merchant) |
| DELETE/PATCH | `/api/webhooks/:id` | session | remove / toggle `{active}` |
| GET | `/api/deliveries?webhookId=&status=&limit=` | session | delivery log for your webhooks (limit 1 to 500, default 100) |

Amounts are raw 6-decimal USDC strings, with `*Usdc` decimal companions
(e.g. `mrrUsdc: "10.000000"`).

## Webhook URLs

Registration refuses any URL that is not https on port 443, carries
credentials, or whose host is (or resolves to) a loopback, private,
link-local, carrier-grade NAT, multicast or reserved address, including the
cloud metadata endpoint `169.254.169.254`. IPv6 must be global unicast.
Each merchant can register at most 5 webhooks. The keeper re-checks every
address at delivery time, so a hostname that later resolves somewhere private
is still refused, and it never follows redirects (a 3xx counts as a failed
delivery). `LEVY_WEBHOOK_ALLOW_PRIVATE=1` lifts these rules for local
development only. Failed deliveries record a coarse reason (`HTTP 500`,
`timeout after 5s`, `connection failed`, `refused: ...`), never raw network
errors.

## Webhook verification (for merchants)

Every delivery POSTs canonical JSON with headers:

- `X-Levy-Signature`: base64 Ed25519 signature over `{timestamp}.{deliveryId}.{event}.{body}`
- `X-Levy-Timestamp`: unix seconds when this attempt was signed
- `X-Levy-Delivery`: delivery id (signed, so safe to dedupe on)
- `X-Levy-Key-Id`: signing key id, also returned by the public-key endpoint
- `X-Levy-Event`: event type, e.g. `charge.succeeded` (signed; reject unknown types)

Verify with the public key from `GET /api/webhooks/public-key`, reject
timestamps more than 5 minutes off, and drop delivery ids already seen.
`verifyDelivery` in `keeper/src/webhooks.ts` does the signature and timestamp
checks; the merchant guide has a standalone example and the payload fields.

## Deploying

With Docker: `docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build`.
The API image builds from the repo root (it compiles `keeper/src` too), runs
as a non-root user that can write only the `/data` volume, and is published on
the host's `127.0.0.1` only. Point a TLS reverse proxy (nginx, Caddy) at it.
Outside Docker the server listens on `LEVY_API_HOST` (default `127.0.0.1`).

`LEVY_PUBLIC_ORIGIN` is required when `NODE_ENV=production`, which the image
sets. The pages are sent with a Content-Security-Policy that allows scripts
only from the origin (never inline) and refuses framing (`PAGE_HEADERS` in
`src/server.ts`), so keep page scripts in `public/*.js`. Put the API behind a
reverse proxy that rate-limits
`POST /api/auth/challenge` per client IP: it is the one unauthenticated endpoint
that writes. The server also caps pending challenges at 10,000 and answers 503
beyond that.

The API and keeper must share one `LEVY_WEBHOOK_KEY_PATH` (compose does this via
`/data`): if the API finds no key file there it creates one, and a key that
differs from the keeper's makes every merchant's signature check fail.

## Tests

```bash
npm test   # 34 tests, seeded temp DB, ephemeral port, real wallet signatures
```

# Levy API + Dashboards (M3)

Read-mostly REST API over the keeper's SQLite database, plus a merchant
dashboard and a customer portal. On-chain writes (plan creation, pause,
cancel, allowance changes) are intentionally out of scope: they must be
signed from a wallet against the SubscriptionManager contract.

## Run

```bash
npm install
cp .env.example .env   # point LEVY_DB_PATH at the keeper's DB
npm start              # http://127.0.0.1:3001
```

Pages: `/` (merchant dashboard), `/portal.html` (customer portal), both signed
in with a browser wallet, and `/checkout.html?plan=<planId>`, where a customer
subscribes: it shows the plan, adds 12 cycles (adjustable) to the customer's
USDC allowance for Levy, and calls `subscribe`. It needs `LEVY_MANAGER_ADDRESS`
and `LEVY_USDC_ADDRESS` set for the API. The page loads no third-party code; its
contract calls are encoded in `public/wallet.js`, checked against the ABI by
`test/wallet.test.ts`.

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

Set `LEVY_PUBLIC_ORIGIN` to the exact origin the dashboard is served from
(e.g. `https://app.getlevy.xyz`). Wallets warn when the page's domain differs
from the message's, and the server never takes the domain from the request.

## Endpoints

Everything except health, plans and the webhook public key needs a session, and
only returns the signed-in address's own data: as merchant (dashboard) or as
subscriber (portal). An address param naming someone else gets 403; another
merchant's webhook or subscription id gets 404.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | public | liveness |
| GET | `/api/config` | public | chain id and contract addresses for the checkout page |
| GET | `/api/plans` | public | distinct plans seen on-chain (read-only mirror) |
| GET | `/api/webhooks/public-key` | public | Ed25519 SPKI PEM for signature verification |
| POST | `/api/auth/challenge`, `/api/auth/verify` | public | sign-in (above) |
| GET | `/api/subscriptions?merchant=\|subscriber=&status=` | session | one of merchant/subscriber, equal to the session |
| GET | `/api/subscriptions/:id` | session | + charges, dunning row; subscriber or merchant only |
| GET | `/api/metrics` | session | MRR (trial+active, per 30 days whatever the cycle), success rate, churn counts, totals |
| GET | `/api/dunning` | session | retry queue with nextRetryAt |
| GET | `/api/charges?subscription=` | session | charge records |
| GET | `/api/invoices?format=csv` | session | alias of charges; `format=csv` downloads CSV |
| GET/POST | `/api/webhooks` | session | list / register `{url, events[]}` |
| DELETE/PATCH | `/api/webhooks/:id` | session | remove / toggle `{active}` |
| GET | `/api/deliveries?webhookId=&status=&limit=` | session | delivery log for your webhooks |

## Webhook URLs

Registration refuses any URL that is not https on port 443, carries
credentials, or whose host is (or resolves to) a loopback, private,
link-local, carrier-grade NAT, multicast or reserved address, including the
cloud metadata endpoint `169.254.169.254`. IPv6 must be global unicast.
Each merchant can register at most 5 webhooks. The keeper re-checks every address at delivery time, so a
hostname that later resolves somewhere private is still refused, and it never
follows redirects (a 3xx counts as a failed delivery).
`LEVY_WEBHOOK_ALLOW_PRIVATE=1` lifts these rules for local development only.
Failed deliveries record a coarse reason (`HTTP 500`, `timeout after 5s`,
`connection failed`, `refused: ...`), never raw network errors.

## Deploying

With Docker: `docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build`.
The API image builds from the repo root (it compiles `keeper/src` too), runs
as a non-root user that can write only the `/data` volume, and is published on
the host's `127.0.0.1` only. Point a TLS reverse proxy (nginx, Caddy) at it.
Outside Docker the server listens on `LEVY_API_HOST` (default `127.0.0.1`).

`LEVY_PUBLIC_ORIGIN` is required when `NODE_ENV=production`, which the image sets. Put the API behind
a reverse proxy that rate-limits `POST /api/auth/challenge` per client IP: it is
the one unauthenticated endpoint that writes. The server also caps pending
challenges at 10,000 and answers 503 beyond that.

Amounts are raw 6-decimal USDC strings, with `*Usdc` decimal companions
(e.g. `mrrUsdc: "10.000000"`).

## Webhook verification (for merchants)

Every delivery POSTs canonical JSON with headers:

- `X-Levy-Signature`: base64 Ed25519 signature over `{timestamp}.{deliveryId}.{body}`
- `X-Levy-Timestamp`: unix seconds when this attempt was signed
- `X-Levy-Delivery`: delivery id (signed, so safe to dedupe on)
- `X-Levy-Key-Id`: signing key id, also returned by the public-key endpoint
- `X-Levy-Event`: event type, e.g. `charge.succeeded`

Verify with the public key from `GET /api/webhooks/public-key`, reject
timestamps more than 5 minutes off, and drop delivery ids already seen.
`verifyDelivery` in `keeper/src/webhooks.ts` does the signature and timestamp
checks; the merchant guide has a standalone example.

## Tests

```bash
npm test   # 28 tests, seeded temp DB, ephemeral port, real wallet signatures
```

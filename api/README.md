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

Dashboards: `/` (merchant), `/portal.html` (customer). Both sign in with a
browser wallet.

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
| GET | `/api/plans` | public | distinct plans seen on-chain (read-only mirror) |
| GET | `/api/webhooks/public-key` | public | Ed25519 SPKI PEM for signature verification |
| POST | `/api/auth/challenge`, `/api/auth/verify` | public | sign-in (above) |
| GET | `/api/subscriptions?merchant=\|subscriber=&status=` | session | one of merchant/subscriber, equal to the session |
| GET | `/api/subscriptions/:id` | session | + charges, dunning row; subscriber or merchant only |
| GET | `/api/metrics` | session | MRR (trial+active), success rate, churn counts, totals |
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

`LEVY_PUBLIC_ORIGIN` is required when `NODE_ENV=production`. Put the API behind
a reverse proxy that rate-limits `POST /api/auth/challenge` per client IP: it is
the one unauthenticated endpoint that writes. The server also caps pending
challenges at 10,000 and answers 503 beyond that.

Amounts are raw 6-decimal USDC strings, with `*Usdc` decimal companions
(e.g. `mrrUsdc: "10.000000"`).

## Webhook verification (for merchants)

Every delivery POSTs canonical JSON with headers:

- `X-Levy-Signature`: base64 Ed25519 signature over the raw body bytes
- `X-Levy-Event`: event type, e.g. `charge.succeeded`
- `X-Levy-Delivery`: delivery id

Verify with the public key from `GET /api/webhooks/public-key`. The keeper
repo has the canonical-JSON + verify helpers in `keeper/src/webhooks.ts`
(`canonicalJson`, `verifySignature`).

## Tests

```bash
npm test   # 22 tests, seeded temp DB, ephemeral port, real wallet signatures
```

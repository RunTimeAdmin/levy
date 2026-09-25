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

Dashboards: `/` (merchant), `/portal.html` (customer).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/plans` | distinct plans seen on-chain (read-only mirror) |
| GET | `/api/subscriptions?merchant=&subscriber=&status=` | subscriber list |
| GET | `/api/subscriptions/:id` | + charges, dunning row |
| GET | `/api/metrics?merchant=` | MRR (trial+active), success rate, churn counts, totals |
| GET | `/api/dunning?merchant=` | retry queue with nextRetryAt |
| GET | `/api/charges?subscription=&merchant=` | charge records |
| GET | `/api/invoices?...&format=csv` | alias of charges; `format=csv` downloads CSV |
| GET/POST | `/api/webhooks?merchant=` | list / register `{merchant, url, events[]}` |
| DELETE/PATCH | `/api/webhooks/:id` | remove / toggle `{active}` |
| GET | `/api/webhooks/public-key` | Ed25519 SPKI PEM for signature verification |
| GET | `/api/deliveries?webhookId=&status=&limit=` | delivery log |

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
npm test   # 12 tests, seeded temp DB, ephemeral port
```

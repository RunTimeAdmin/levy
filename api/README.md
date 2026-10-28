# Levy API + Pages

Fastify API over the keeper's SQLite database, plus the merchant dashboard,
customer portal and checkout page. The API holds no on-chain key and signs no
transactions (it keeps only the webhook signing key): on-chain writes (plan creation and retirement, payout and
ownership changes, subscribe, pause, resume, cancel, plan changes, wallet transfers,
allowance changes) are signed in the user's wallet, and the pages build those
transactions in the browser. The pages encode manager v2's calls
(`docs/manager-v2-design.md`), so they work only against a v2 deployment.

## Run

Requires Node 24 (22.13 or later also works; the API imports the keeper's `src/db.ts`, which uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # point LEVY_DB_PATH at the keeper's DB
npm start              # loads .env if present; http://127.0.0.1:3001
```

For production use the Docker image (see Deploying); it is compiled with `tsc`.

## Pages

- `/`: merchant dashboard, for a merchant account the signed-in wallet owns (a picker when it owns several). The account panel: owner, where payments go, Set payout and Pay the owner again, Offer the account and Withdraw the offer, and Accept for an account offered to this wallet. Metrics; plans with their terms (intro price, number of payments, transferable), copyable checkout links, Retire or Reopen, and a New plan form (a `createPlan` transaction from the owner's wallet); subscriptions (with the merchant's reference and each subscriber's allowance runway) that the merchant can pause or cancel, and resume only when the merchant made the pause (a pause by the customer or after failed payments shows "customer resumes" instead); dunning queue; webhooks with a per-endpoint delivery log; invoice CSV.
- `/portal.html`: customer portal. Subscriptions and invoice history ("paid through" once a limited plan completes); pause, resume and cancel; plan changes to another plan of the same merchant account that is not retired, priced from the contract's own state before signing; moving a subscription to another wallet on a transferable plan, and accepting one offered to this wallet; and the Levy allowance, with a top-up and a revoke.
- `/checkout.html?plan=<planId>&ref=<reference>`: where a customer subscribes. It refuses a retired plan, shows the plan with its intro price and number of payments, explains the allowance, adds 12 cycles (adjustable, 1 to 120, and at most a limited plan's payments, all of them by default; intro payments at the intro price) to the customer's USDC allowance for Levy, calls `subscribe` and ends on a receipt. `ref` is optional: `0x` plus 64 hex digits, or up to 31 ASCII characters (see the merchant guide). Needs `LEVY_MANAGER_ADDRESS` and `LEVY_USDC_ADDRESS` set for the API; the examples' zero address counts as unset, and the page then says checkout is not configured.

On any chain other than Arc mainnet, all three pages show a bar under the header saying it is a test network (`public/network.js`, from `/api/config`).

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

The dashboard and portal send `{nonce, signature, cookie: true}` to verify
instead. The session then goes into an HttpOnly, SameSite=Strict cookie
(`__Host-levy_session` over https, `levy_session` on a local http origin) and
the response has no `token`, so page scripts never hold it. A write (any method
but GET) authenticated by the cookie must carry an `Origin` header equal to
`LEVY_PUBLIC_ORIGIN`, or it gets 403: SameSite alone would still let a sibling
site such as getlevy.xyz send the cookie. A request with an `Authorization`
header is judged by that header alone.

Set `LEVY_PUBLIC_ORIGIN` to the exact origin the pages are served from
(e.g. `https://app.getlevy.xyz`). Wallets warn when the page's domain differs
from the message's, and the server never takes the domain from the request.

## Endpoints

Everything except health, config, plans, the webhook public key and the
sign-in routes needs a session, and only returns the signed-in address's own
data: as owner of a merchant account (dashboard) or as subscriber (portal).
Merchant routes take an optional `merchant` (query, or body for
`POST /api/webhooks`) naming the account, defaulting to the signed-in
address's own; the signed-in address must own it now, by the keeper's mirror
of `ownerOf`, or it gets 403, so a previous owner loses access once a handover
is indexed. A `subscriber` or `pendingTransfer` param naming someone else gets
403; another account's webhook or subscription id gets 404.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | public | liveness |
| GET | `/api/config` | public | chain id and contract addresses, for the checkout page and portal |
| GET | `/api/plans` | public | every on-chain plan (read-only mirror, including plans with no subscribers), with `retired`, `transferable`, `maxCycles`, `introPrice`, `introPriceUsdc` and `introCycles` |
| GET | `/api/webhooks/public-key` | public | Ed25519 SPKI PEM and its `keyId`, plus the event list |
| POST | `/api/auth/challenge`, `/api/auth/verify` | public | sign-in (above) |
| GET | `/api/auth/session`, POST `/api/auth/logout` | session | check or revoke the session |
| GET | `/api/accounts` | session | `{owned, offered}`: the merchant accounts the session owns, and those offered to it awaiting `acceptOwnership`, each with `owner`, `payout` (null while it follows the owner), `paidTo` and `pendingOwner` |
| GET | `/api/subscriptions?merchant=\|subscriber=\|pendingTransfer=&status=` | session | one of merchant (an account the session owns), subscriber or pendingTransfer (both equal to the session; pendingTransfer lists subscriptions offered to this wallet); `status` is numeric (0 trial, 1 active, 2 past_due, 3 paused, 4 cancelled, 5 completed); rows include `ref`, `pausedByMerchant` (1 while the merchant's own pause holds it, else 0), `introCyclesLeft`, `planCycles`, `pendingTransfer`, `fundsLow`, `cyclesCovered` |
| GET | `/api/subscriptions/:id` | session | + charges, dunning row; the subscriber or the current owner of its merchant account only |
| GET | `/api/funds` | session | the subscriber's allowance runway as of the keeper's last check (`low`, `cyclesCovered`, allowance, balance) |
| GET | `/api/metrics` | session | as merchant: MRR (trial + active, normalized to 30 days), counts per status (including `completedSubs`), totals, charge success rate, dunning depth |
| GET | `/api/dunning` | session | as merchant: retry queue with nextRetryAt. A subscription that was then paused or cancelled stays listed until its retry time passes |
| GET | `/api/charges?subscription=` | session | as merchant: charge records |
| GET | `/api/invoices?format=csv` | session | alias of charges; `format=csv` downloads CSV |
| GET/POST | `/api/webhooks` | session | list / register `{url, events[], merchant?}` (at most 5 per merchant account) |
| DELETE/PATCH | `/api/webhooks/:id` | session | remove / toggle `{active}` |
| GET | `/api/deliveries?merchant=&webhookId=&status=&limit=` | session | delivery log for the account's webhooks (limit 1 to 500, default 100) |

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

- `X-Levy-Signature`: base64 Ed25519 signature over `{timestamp}.{deliveryId}.{webhookId}.{event}.{body}`
- `X-Levy-Timestamp`: unix seconds when this attempt was signed
- `X-Levy-Delivery`: delivery id (signed, so safe to dedupe on)
- `X-Levy-Webhook`: the endpoint id the delivery was made for
- `X-Levy-Key-Id`: signing key id, also returned by the public-key endpoint
- `X-Levy-Event`: event type, e.g. `charge.succeeded` (signed; reject unknown types)

Verify with the public key from `GET /api/webhooks/public-key`, using your own
endpoint's id for `{webhookId}` rather than the header, reject timestamps more
than 5 minutes off, drop delivery ids already seen, and check that `merchant`
is your account.
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

The API serves the public key the keeper writes to `LEVY_WEBHOOK_PUBLIC_KEY_PATH`
(compose puts it on `/data`) and answers 503 until the keeper has written it. It
never reads or creates the private key, and it refuses to start if
`LEVY_KEEPER_KEY` or `LEVY_WEBHOOK_KEY` is in its environment. It also refuses a
database the keeper recorded for another chain, manager or USDC.

## Tests

```bash
npm test   # 79 tests, seeded temp DB, ephemeral port, real wallet signatures
```

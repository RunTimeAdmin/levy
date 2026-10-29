# API Reference

The Levy API is a Fastify server that reads the keeper's SQLite database and serves the three browser pages. It holds no on-chain key and sends no transactions: plans, subscriptions, pauses, cancels and allowance changes are signed in the user's wallet (see [Dashboard-Portal-and-Checkout.md](Dashboard-Portal-and-Checkout.md)). The API writes only sign-in state and webhook registrations. Every route lives on one origin, for example `https://app.getlevy.xyz` on Arc testnet.

## Conventions

- **Amounts.** USDC has 6 decimals, so 1 USDC = 1,000,000 units. Raw amounts are decimal strings of units (`"10000000"` is 10 USDC) and most have a companion ending in `Usdc` (`"10.000000"`).
- **Times and ids.** Times are unix seconds; some rows add an ISO string. `planId` and `subId` are strings.
- **Errors.** `{"statusCode":401,"error":"Unauthorized","message":"sign in required"}`. Read `message`.
- **Session.** A bearer token or the page cookie from [Authentication.md](Authentication.md). A session route without a valid one answers 401.
- **Scoping.** A session route returns only the signed-in address's data. A `subscriber` or `pendingTransfer` parameter, where accepted, must equal that address: malformed is 400, someone else's is 403. A `merchant` parameter (query, or body for `POST /api/webhooks`) names the merchant account to act for and defaults to the signed-in address's own. The signed-in address must own that account now, by the keeper's mirror of `ownerOf`: malformed is 400, an account someone else owns is 403. So once a handover is indexed, the previous owner loses the account's data and webhooks. A subscription or webhook id owned by someone else is 404, the same as a missing one. Charges, dunning rows and deliveries are filtered in the query, so other people's rows are absent.

## Public routes

| Route | Response |
|---|---|
| `GET /api/health` | `{"ok":true,"service":"levy-api","version":"0.1.0"}` |
| `GET /api/config` | `{chainId, managerAddress, usdcAddress}`; an address is `null` when unset, malformed or all zeros. |
| `GET /api/plans` | Every plan of every merchant account: `planId, merchant, price, priceUsdc, cycleSeconds, cycleDays, trialSeconds, maxFailed, retired, transferable, maxCycles, introPrice, introPriceUsdc, introCycles`. `retired` and `transferable` are booleans, `maxCycles` is 0 for no limit, and `introPrice` is `"0"` when the plan has no intro price. A read-only mirror of the on-chain registry, including plans with no subscribers. |
| `GET /api/webhooks/public-key` | `{algorithm:"ed25519", keyId, publicKey, events}` (SPKI PEM and the thirteen event names), read from the public key file the keeper publishes. 503 until the keeper has published it. |

Testnet `/api/config` today:

```json
{"chainId":5042002,"managerAddress":"0xea24ac9c1217a671139d93225fdcf19ea3c4df4e","usdcAddress":"0x3600000000000000000000000000000000000000"}
```

## Auth routes

Flow and security details are in [Authentication.md](Authentication.md).

| Route | Body | Response |
|---|---|---|
| `POST /api/auth/challenge` | `{address}` | `{nonce, message}`. 400 bad address; 503 when 10,000 challenges are pending. |
| `POST /api/auth/verify` | `{nonce, signature, cookie?}` | `{token, address, expiresAt}`, or with `cookie: true` `{address, expiresAt}` plus `Set-Cookie`. 401 for an expired, used or unknown nonce or a wrong signature. |
| `GET /api/auth/session` (session) | none | `{address}` |
| `POST /api/auth/logout` (session) | none | `{ok:true}`; revokes the calling session. |

## Merchant accounts

| Route (session) | Notes |
|---|---|
| `GET /api/accounts` | `{owned, offered}`. `owned` lists the accounts the signed-in address acts for: its own, unless it handed that on, and any handed to it. `offered` lists accounts whose owner proposed the signed-in address, awaiting its `acceptOwnership`. Each entry is `{account, owner, payout, paidTo, pendingOwner}`: `payout` is the fixed payout or `null` while the share follows the owner, `paidTo` is where payments go now, and `pendingOwner` is `null` when no handover is open. |

The accounts come from the keeper's `merchant_accounts` mirror, so a transaction shows up after the keeper's next sync.

## Subscriptions and funds

| Route (session) | Notes |
|---|---|
| `GET /api/subscriptions` | `merchant`, `subscriber` or `pendingTransfer` is required (400 `pass merchant, subscriber or pendingTransfer`). `merchant` lists an account's subscriptions, `subscriber` your own, and `pendingTransfer` those offered to your wallet with `proposeTransfer`. Optional `status` 0 trial, 1 active, 2 past_due, 3 paused, 4 cancelled, 5 completed. Ordered by `subId`. |
| `GET /api/subscriptions/:id` | The subscriber, or the current owner of the subscription's merchant account, else 404. Adds `charges` (with `amountUsdc`, `feeUsdc`) and `dunning` (`{subId, attempts, nextRetryAt, updatedAt}` or `null`). |
| `GET /api/funds` | The signed-in subscriber's allowance runway. |

```json
{"subId":"1","subscriber":"0x...","planId":"1","merchant":"0x...","price":"10000000",
 "cycleSeconds":2592000,"status":1,"nextChargeAt":1700000000,"failedAttempts":0,
 "ref":"0x7f3a...","pausedByMerchant":0,"introCyclesLeft":0,"planCycles":0,
 "pendingTransfer":null,"fundsLow":1,"cyclesCovered":1,
 "statusName":"active","priceUsdc":"10.000000","nextChargeAtIso":"2023-11-14T22:13:20.000Z"}
```

`ref` is the merchant's bytes32 reference or `null`. `pausedByMerchant` is 1 while the merchant's own pause holds the subscription, else 0; the merchant may resume only at 1, and the dashboard offers Resume only then. `price` is the plan's full price. `introCyclesLeft` is read only for plans with intro pricing and `planCycles` only for plans with a cycle limit, so both are 0 otherwise. `pendingTransfer` is the wallet the subscriber offered the subscription to, or `null`; it is read only on transferable plans. For a completed subscription `nextChargeAt` is the end of the last paid cycle. `fundsLow` and `cyclesCovered` are `null` until the keeper has checked that subscriber; the detail route omits them.

`/api/funds` returns `{checked:false}` before the first check, then `allowance, balance, perCycle, cyclesCovered, low` with `*Usdc` companions, as of the keeper's last check (repeated at least every 6 hours). The allowance is one pool, so `perCycle` sums the next charge of every chargeable subscription the address holds, at the intro price for an intro cycle, and `cyclesCovered` is the allowance divided by it. `low` means the allowance does not cover the next two charges of all of them, counting none past a limited plan's last. A limited plan whose remaining charges are covered is therefore not low, even with `cyclesCovered` below 2.

## Metrics and dunning

| Route (session) | Response |
|---|---|
| `GET /api/metrics` | `mrr, totalSubs, activeSubs, trialSubs, pastDueSubs, pausedSubs, cancelledSubs, completedSubs, totalCharged, totalFees, chargeCount, failureCount, successRate, dunningDepth`; raw amounts also have `*Usdc` companions. Optional `merchant`. |
| `GET /api/dunning` | The account's retry queue, soonest first: `subId, attempts, nextRetryAt, updatedAt, subscriber, planId, price, priceUsdc, status, nextRetryAtIso`. Optional `merchant`. |

`mrr` covers trial and active subscriptions. Each price is scaled to 30 days in integer math, rounded down per subscription: a weekly 10 USDC plan adds 42.857142 USDC. `successRate` is charges over charges plus failures (0 to 1, `null` before any attempt). A subscription paused or cancelled after failing stays in the dunning queue, and in `dunningDepth`, until its retry time passes.

## Charges and invoices

`GET /api/charges` and `GET /api/invoices` are one handler: charge records, newest first, for the merchant account (`merchant`, default the signed-in address). Query `subscription` narrows to one subscription (an id that is not yours gives an empty list, not 404). `format=csv` returns `text/csv` as the attachment `levy-invoices.csv`.

Row fields: `id, subId, subscriber, merchant, amount, fee, amountUsdc, feeUsdc, invoiceRef, txHash, blockNumber, chargeCount`. CSV columns, in order, with decimal USDC amounts and no quoting (values are hex or digits):

```text
id,invoiceRef,subId,subscriber,merchant,amountUsdc,feeUsdc,txHash,blockNumber,chargeCount
```

## Webhooks

Delivery, signing and retries are the keeper's job; see [Webhooks.md](Webhooks.md).

| Route (session) | Notes |
|---|---|
| `GET /api/webhooks` | The account's endpoints (`merchant` optional): rows `{id, merchant, url, events, active, created_at}`; `events` is an array, `active` is 0 or 1. |
| `POST /api/webhooks` | `{url, events}`, plus `merchant` for an account you own other than your own address. The endpoint belongs to the account. Returns `{id}`. |
| `PATCH /api/webhooks/:id` | `{active: boolean}`. Returns `{ok:true}`. |
| `DELETE /api/webhooks/:id` | Returns `{ok:true}`. |

Registration is refused with a 400, checked in this order:

1. More than 5 webhooks for the account: `webhook limit reached (5 per merchant)`.
2. A URL that is not https, carries credentials, uses a port other than 443, or has any resolved address that is private, loopback, link-local or reserved. The keeper checks again on every delivery.
3. `events` not a non-empty array of known event names (`unknown event type: ...`). Duplicates are dropped.

A non-integer `:id` is 400 `invalid id`; a webhook of an account you do not own now is 404 `webhook not found`. Setting `active: false` stops new events for the endpoint and dead-letters deliveries still queued for it. Deleting does the same and hides its deliveries from the log.

## Deliveries

`GET /api/deliveries` (session) lists attempts for the account's webhooks, newest first (`merchant` optional, as above). `webhookId` must be an integer (400 `invalid webhookId`; a webhook that is not yours gives an empty list). `status` is `pending`, `sent`, `failed` (waiting for a retry) or `dead` (given up), else 400 `invalid status`. `limit` is 1 to 500, default 100; non-numbers fall back to 100.

Row fields: `id, webhook_id, event_type, payload, status, attempts, next_retry_at, created_at, last_error, event_key`. `payload` is the exact canonical JSON that was or will be sent. `event_key` is the `txHash:logIndex` of the log behind the event (null for `allowance.low` and rows queued before 2026-10-28).

## Pages

`GET /` (dashboard), `/portal.html`, `/checkout.html` and `/public/*` (scripts, stylesheet, logos). Only HTML carries the security headers listed in [Dashboard-Portal-and-Checkout.md](Dashboard-Portal-and-Checkout.md). `/index.html` is not a route. A path outside the public folder gives `{"error":"forbidden"}`, a missing file `{"error":"not found"}`.

## Errors and limits

| Status | Messages |
|---|---|
| 400 | `invalid merchant address`, `invalid subscriber address`, `invalid pendingTransfer address`, `address must be a 0x address`, `nonce and hex signature required`, `active must be boolean`, and the cases above |
| 401 | `sign in required`, `session expired or invalid`, `challenge expired or already used`, `signature does not match the address` |
| 403 | `the signed-in address does not own that merchant account`, `subscriber must be the signed-in address`, `pendingTransfer must be the signed-in address`, `cross-origin request refused` (cookie write without the right `Origin`) |
| 404 | `subscription not found`, `webhook not found`, unknown route |
| 429 | Reverse proxy: too many `POST /api/auth/challenge` from one IP |
| 503 | `too many pending sign-ins; retry in a few minutes`; `signing key not available (keeper has not booted yet)` while the keeper has not published the public key |

| Limit | Value |
|---|---|
| Webhooks per merchant account | 5 |
| Deliveries per request | 1 to 500, default 100 |
| Pending sign-in challenges | 10,000 |
| Challenge lifetime, session lifetime | 5 minutes, 24 hours |
| Challenge requests (nginx example) | 10 a minute per IP, burst 5, then 429 |
| Request body (nginx example) | 64 KB |

There is no pagination: subscriptions, charges, dunning rows and webhooks return every row for the address. The dashboard shows the latest 50 invoices and points to the CSV for the rest.

## Example: sign in and list subscriptions

A merchant backend signs in with the wallet that owns its merchant account, which must be an ordinary (EOA) wallet.

```bash
BASE=https://app.getlevy.xyz
ME=0xYourMerchantWallet

# 1. Challenge: {"nonce":"...","message":"app.getlevy.xyz wants you to sign in ..."}
curl -s -X POST $BASE/api/auth/challenge \
  -H 'content-type: application/json' -d "{\"address\":\"$ME\"}"

# 2. Sign "message" exactly as returned (EIP-191 personal_sign),
#    for example with viem: account.signMessage({ message })

# 3. Verify: {"token":"...","address":"0x...","expiresAt":1760000000}
curl -s -X POST $BASE/api/auth/verify \
  -H 'content-type: application/json' -d '{"nonce":"...","signature":"0x..."}'

# 4. Use the token for 24 hours
curl -s "$BASE/api/subscriptions?merchant=$ME&status=1" \
  -H "authorization: Bearer $TOKEN"
```

## Source files

- [api/src/server.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/server.ts)
- [api/src/auth.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/auth.ts)
- [api/README.md](https://github.com/RunTimeAdmin/levy/blob/main/api/README.md)
- [keeper/src/db.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/db.ts)
- [keeper/src/webhooks.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhooks.ts)
- [keeper/src/webhook-url.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhook-url.ts)
- [keeper/src/funds.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/funds.ts)
- [ops/nginx-app.conf.example](https://github.com/RunTimeAdmin/levy/blob/main/ops/nginx-app.conf.example)
- [docs/merchant-guide.md](https://github.com/RunTimeAdmin/levy/blob/main/docs/merchant-guide.md)

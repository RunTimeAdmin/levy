# Levy Merchant Guide

How to accept recurring USDC subscriptions on Arc with Levy.

## Prerequisites

- A wallet with USDC on Arc (for gas and for receiving payments).
- The Levy API base URL from your deployment (the examples below use `http://127.0.0.1:3001`; replace with your host).
- The `SubscriptionManager` contract address for your deployment. Contract addresses are published at mainnet launch.

All USDC amounts in this guide are in 6-decimal units: 1 USDC = 1,000,000.

## 1. Create a plan

Plans live on-chain and are immutable. Call `createPlan` on the `SubscriptionManager` contract:

```
createPlan(
  price,         // uint256, per-cycle price in 6-decimal USDC units
  cycleSeconds,  // uint256, billing cycle length in seconds
  trialSeconds,  // uint256, trial length in seconds (0 for none)
  graceSeconds,  // uint256, reserved for future use
  maxFailed      // uint8, failed pulls before the subscription goes PAST_DUE
)
```

Common cycle values:

- Weekly: 604800
- Monthly: 2592000 (30 days)
- Quarterly: 7776000 (90 days)
- Yearly: 31536000 (365 days)

The call emits `PlanCreated` with your `planId`. Save it; subscribers need it.

To list plans from the API:

```
GET /api/plans
```

### Parameters, explained

- `price`: what the subscriber pays each cycle. Fixed at creation.
- `cycleSeconds`: how often the pull happens. Keep it aligned to the presets above unless you have a reason not to.
- `trialSeconds`: the subscriber is not charged until the trial ends. Set to 0 to skip trials.
- `maxFailed`: how many failed pulls the subscription tolerates before the contract marks it `PAST_DUE`. At twice this number, the contract pauses the subscription automatically. A value of 2 or 3 fits most businesses.

## 2. Register a webhook endpoint

Levy signs every billing event with Ed25519 and POSTs it to your URL. Register an endpoint:

```
POST /api/webhooks
Content-Type: application/json

{
  "merchant": "0xYourMerchantAddress",
  "url": "https://your-domain.com/hooks/levy",
  "events": ["charge.succeeded", "charge.failed", "dunning.started", "subscription.cancelled"]
}
```

Available event types:

- `subscription.created`
- `charge.succeeded`
- `charge.failed`
- `dunning.started`
- `subscription.paused`
- `subscription.resumed`
- `subscription.cancelled`
- `invoice.ready`

Manage endpoints with the API:

```
GET    /api/webhooks?merchant=0xYourMerchantAddress
DELETE /api/webhooks/:id
PATCH  /api/webhooks/:id        {"active": false}
GET    /api/deliveries?webhookId=:id&status=failed
```

Deliveries retry with exponential backoff and are marked dead after 24 hours of failures. Check `/api/deliveries` for anything stuck.

## 3. Verify webhook signatures

Every webhook POST carries three headers:

- `X-Levy-Signature`: base64 Ed25519 signature over the raw request body bytes.
- `X-Levy-Event`: the event type, e.g. `charge.succeeded`.
- `X-Levy-Delivery`: the delivery id (for idempotency; store it and ignore repeats).

Fetch the public key:

```
GET /api/webhooks/public-key
```

The response includes the SPKI PEM public key and the algorithm (`ed25519`).

Verification steps:

1. Read the raw request body bytes exactly as received (before JSON parsing).
2. Base64-decode the `X-Levy-Signature` header.
3. Verify the Ed25519 signature against the body bytes with the public key.
4. Reject the request if verification fails.

Example in Node.js:

```js
import { createPublicKey, verify } from "node:crypto";

const { publicKey } = await fetch(API + "/api/webhooks/public-key").then(r => r.json());
const key = createPublicKey(publicKey);

function isValid(rawBody, signatureB64) {
  return verify(null, rawBody, key, Buffer.from(signatureB64, "base64"));
}
```

Rotate your trust only when the public key endpoint returns a new key. Levy signs with one key per deployment.

## 4. Read invoices

Every successful charge is an invoice record: reference, amount, fee, transaction hash, block number, and charge count.

```
GET /api/invoices?merchant=0xYourMerchantAddress
GET /api/invoices?subscription=3
GET /api/invoices?merchant=0xYourMerchantAddress&format=csv
```

The CSV download has the columns: `id,invoiceRef,subId,subscriber,merchant,amountUsdc,feeUsdc,txHash,blockNumber,chargeCount`. Amounts are in whole USDC.

## 5. Dunning: what happens when a pull fails

A pull fails when the subscriber has insufficient USDC or has revoked the allowance. The contract never reverts on a failed pull; it records the failure on-chain and emits `ChargeFailed`. From there:

1. The keeper retries on a schedule (default: 1 day, 3 days, 7 days after each failure; configurable per deployment).
2. When failures reach your plan's `maxFailed`, the subscription moves to `PAST_DUE`. It is still chargeable; the keeper keeps retrying.
3. At twice `maxFailed` failures, the contract pauses the subscription automatically. No further pulls happen until someone resumes it.
4. A successful pull at any point clears the failure count and the retry schedule.

You receive `charge.failed` on every failure, `dunning.started` on the first failure, and `subscription.paused` if the contract auto-pauses. Use these to email the subscriber or flag the account in your own system. Levy does not send subscriber emails; that is your layer.

A subscriber fixes a failed subscription by topping up USDC or re-granting the allowance. The next scheduled retry (or a manual `charge` call) picks it up.

## 6. The subscriber flow

Send the subscriber your `planId`. They:

1. Call `approve` on the USDC contract for the `SubscriptionManager` address, for at least one cycle's price (more if they want a buffer).
2. Call `subscribe(planId)` on the `SubscriptionManager`.

That is the whole onboarding. One approval, one subscribe call.

## FAQ

**How do I reprice?**
Create a new plan with the new price and point new subscribers at it. Plans are immutable, so existing subscriptions keep the old price until the subscriber moves. There is no on-chain repricing.

**How do refunds work?**
Refunds are your policy and happen off-chain: send USDC back to the subscriber from your own wallet. The contract has no refund function, and cancelled subscriptions are terminal.

**How do I cancel a subscriber?**
Call `cancelSubscription(subId)` as the merchant, or have the subscriber call it themselves. Cancellation is terminal; the subscription cannot be resumed. For a temporary stop, use `pauseSubscription` instead, which freezes `nextChargeAt` until `resumeSubscription` is called.

**What does the 1% fee apply to?**
Each collected payment. The contract sends 99% to the merchant address on the plan and 1% to the FeeRouter in the same transaction. Failed pulls cost nothing.

**Who pays gas for charges?**
The keeper pays gas for the `charge` calls it submits. On Arc, gas is paid in USDC and costs are small. Charges are permissionless; the keeper is the always-on caller you do not have to run yourself.

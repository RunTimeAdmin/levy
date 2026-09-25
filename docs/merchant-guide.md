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
- `trialSeconds`: the subscriber is not charged until the trial ends. Set to 0 to skip trials; the first cycle is then charged the moment they subscribe.
- `maxFailed`: how many failed pulls the subscription tolerates before the contract marks it `PAST_DUE`. At twice this number, the contract pauses the subscription automatically. A value of 2 or 3 fits most businesses.

## 2. Register a webhook endpoint

Levy signs every billing event with Ed25519 and POSTs it to your URL. The easiest way to register one is the merchant dashboard: sign in with the wallet that created your plans and use "Add endpoint".

From your own backend, sign in first (the API README covers the three calls: challenge, wallet signature, verify), then send the session token:

```
POST /api/webhooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://your-domain.com/hooks/levy",
  "events": ["charge.succeeded", "charge.failed", "dunning.started", "subscription.cancelled"]
}
```

The endpoint must be https on the default port (443) at a public address. Levy refuses private, loopback and cloud-metadata addresses, and does not follow redirects, so point it at the final URL. Each merchant can register up to 5 endpoints. Respond within 5 seconds; do slow work after acknowledging.

Available event types:

- `subscription.created`
- `subscription.updated` (the subscriber changed plan: `oldPlanId`, `newPlanId`, `credit`)
- `charge.succeeded`
- `charge.failed`
- `dunning.started`
- `subscription.paused`
- `subscription.resumed`
- `subscription.cancelled`
- `invoice.ready`
- `allowance.low` (the subscriber's USDC allowance for Levy covers fewer than 2 more rounds of their subscriptions: `allowance`, `balance`, `cyclesCovered`, `nextChargeAt`)

`allowance.low` is your cue to email the customer before their payments start failing. The allowance is one pool shared by all of a subscriber's Levy subscriptions, so it runs down with every charge; the warning is sent once, and again only if the subscriber tops up and later runs low again. Customers top up from the portal. Your dashboard's Allowance column shows the same thing. Only direct USDC approvals count, not Permit2 allowances.

Manage endpoints with the API (same `Authorization` header; you only ever see your own):

```
GET    /api/webhooks
DELETE /api/webhooks/:id
PATCH  /api/webhooks/:id        {"active": false}
GET    /api/deliveries?webhookId=:id&status=failed
```

Deliveries retry with exponential backoff and are marked dead after 24 hours of failures. Check `/api/deliveries` for anything stuck.

## 3. Verify webhook signatures

Every webhook POST carries these headers:

- `X-Levy-Signature`: base64 Ed25519 signature over `{timestamp}.{deliveryId}.{raw body}`.
- `X-Levy-Timestamp`: unix seconds when this attempt was signed (retries get a fresh one).
- `X-Levy-Delivery`: the delivery id. Store it and ignore repeats.
- `X-Levy-Key-Id`: which signing key was used (matches `keyId` below).
- `X-Levy-Event`: the event type, e.g. `charge.succeeded`.

Fetch the public key:

```
GET /api/webhooks/public-key
```

The response includes the SPKI PEM public key, its `keyId`, and the algorithm (`ed25519`).

Verification steps:

1. Read the raw request body exactly as received (before JSON parsing).
2. Reject the request if `X-Levy-Timestamp` is more than 5 minutes from your clock. A captured delivery then cannot be replayed later.
3. Build `{X-Levy-Timestamp}.{X-Levy-Delivery}.{raw body}` and verify the base64 `X-Levy-Signature` over it with the public key. Reject on failure.
4. Drop the request if you already processed that `X-Levy-Delivery` id (the id is signed, so this is safe).

Example in Node.js:

```js
import { createPublicKey, verify } from "node:crypto";

const { publicKey } = await fetch(API + "/api/webhooks/public-key").then(r => r.json());
const key = createPublicKey(publicKey);

function isValid(rawBody, headers) {
  const ts = headers["x-levy-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const signed = Buffer.from(`${ts}.${headers["x-levy-delivery"]}.${rawBody}`, "utf-8");
  return verify(null, signed, key, Buffer.from(headers["x-levy-signature"], "base64"));
}
```

`verifyDelivery` in `keeper/src/webhooks.ts` does the same checks.

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

1. The keeper retries per failure: after failure 1 it retries in 1 day, after failure 2 in 3 days, after failure 3 and beyond every 7 days (configurable per deployment via `LEVY_DUNNING_DAYS`).
2. When failures reach your plan's `maxFailed`, the subscription moves to `PAST_DUE`. It is still chargeable; the keeper keeps retrying.
3. At twice `maxFailed` failures, the contract pauses the subscription automatically. No further pulls happen until someone resumes it. Resuming starts a fresh retry run and bills from the resume date; the overdue cycle is not collected.
4. A successful pull at any point clears the failure count and the retry schedule.

You receive `charge.failed` on every failure, `dunning.started` on the first failure, and `subscription.paused` if the contract auto-pauses. Use these to email the subscriber or flag the account in your own system. Levy does not send subscriber emails; that is your layer.

A subscriber fixes a failed subscription by topping up USDC or re-granting the allowance. The next scheduled retry (or a manual `charge` call) picks it up.

## 6. The subscriber flow

The easiest way: send the subscriber your checkout link, `https://<your Levy host>/checkout.html?plan=<planId>`. It shows the plan, connects their wallet, and walks them through the approval and the subscription (two wallet confirmations). Without a trial, the first cycle is charged right away.

To build your own flow instead, there are two ways to onboard:

**Direct approve (two transactions).** The subscriber:
1. Calls `approve` on the USDC contract for the `SubscriptionManager` address, for at least one cycle's price (more for a buffer).
2. Calls `subscribe(planId)` on the `SubscriptionManager`. Without a trial this charges the first cycle immediately, and fails if it can't.

**Permit2 (one transaction).** The subscriber signs an off-chain EIP-712 Permit2 message authorizing the `SubscriptionManager` to pull USDC (spender = the manager address, token = USDC). The subscriber then submits `subscribeWithPermit2(planId, permitSingle, signature)` from the same wallet. One transaction, atomic. Only the signer can submit it. Uses Arc's Permit2 contract at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

## FAQ

**How do I reprice?**
Create a new plan with the new price and point new subscribers at it. Plans are immutable, so existing subscriptions keep the old price until the subscriber moves. There is no on-chain repricing.

**How do refunds work?**
Refunds are your policy and happen off-chain: send USDC back to the subscriber from your own wallet. The contract has no refund function, and cancelled subscriptions are terminal.

**How do I cancel a subscriber?**
Call `cancelSubscription(subId)` as the merchant, or have the subscriber do it themselves: the customer portal (`/portal.html`) has Pause, Resume and Cancel buttons that send the transaction from their wallet. Cancellation is terminal; the subscription cannot be resumed. For a temporary stop, use `pauseSubscription` instead. Nothing is charged while paused. On `resumeSubscription`, if the next charge date has passed, billing restarts from the resume date; paused cycles are never billed. Days already paid for keep running during the pause.

**What does the 1% fee apply to?**
Each collected payment. The contract sends 99% to the merchant address on the plan and 1% to the FeeRouter in the same transaction. Failed pulls cost nothing.

**Who pays gas for charges?**
The keeper pays gas for the `charge` calls it submits. On Arc, gas is paid in USDC and costs are small. Charges are permissionless; the keeper is the always-on caller you do not have to run yourself.

# Levy Merchant Guide

How to accept recurring USDC subscriptions on Arc with Levy.

The public version of this guide is `site/docs.html` (getlevy.xyz/docs.html), which adds a testnet quickstart and the deployed addresses. Change both together.

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
  graceSeconds,  // uint256, informational only (the retry schedule lives in the keeper)
  maxFailed      // uint8, failed pulls before the subscription goes PAST_DUE
)
```

The simplest way is the dashboard: sign in with the wallet that should receive
the payments and use **New plan** under Plans. It shows what customers will pay,
checks the limits below, and sends the transaction from your wallet. You can
also call it directly (for example with `cast send`). Rules the contract enforces:
`price` above 0, `cycleSeconds` from 1 day (86400) up to 10 years, `trialSeconds`
shorter than `cycleSeconds`, `maxFailed` from 1 to 255.

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
- `cycleSeconds`: how often the pull happens. "Monthly" is a fixed 30 days, so billing dates drift against calendar months.
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

Available event types. Every payload carries `subId`, `merchant` and `ref`
(your reference from subscribe, or `null`), plus:

| Event | Extra payload fields |
|---|---|
| `subscription.created` | `subscriber`, `planId`, `nextChargeAt` |
| `subscription.updated` | the subscriber changed plan: `oldPlanId`, `newPlanId`, `credit`, `txHash`, `blockNumber` |
| `charge.succeeded` | `amount`, `fee` (6-decimal units; `amount` is 0 when proration credit covered the cycle), `invoiceRef`, `chargeCount`, `txHash`, `blockNumber` |
| `invoice.ready` | same body as `charge.succeeded`, sent alongside it |
| `charge.failed` | `failedAttempts`, `txHash`, `blockNumber` |
| `dunning.started` | first failure only: `nextRetryAt` (unix seconds) |
| `subscription.paused` | `auto`: true when the contract paused it after repeated failures, false when you or the subscriber paused it |
| `subscription.resumed` | none |
| `subscription.cancelled` | none |
| `allowance.low` | `subscriber`, `allowance`, `balance`, `cyclesCovered`, `nextChargeAt` |

`subscription.resumed` and `subscription.cancelled` have identical bodies, so
use the `X-Levy-Event` header (it is signed) or your endpoint URL to tell events apart.

`allowance.low` is your cue to email the customer before their payments start failing. The allowance is one pool shared by all of a subscriber's Levy subscriptions, so it runs down with every charge; the warning is sent once per subscription, and again only if the subscriber tops up and later runs low again. Customers top up from the portal. Your dashboard's Allowance column shows the same thing. Only direct USDC approvals count, not Permit2 allowances, so a subscriber who used Permit2 is flagged low right after subscribing.

Manage endpoints with the API (same `Authorization` header; you only ever see your own):

```
GET    /api/webhooks
DELETE /api/webhooks/:id
PATCH  /api/webhooks/:id        {"active": false}
GET    /api/deliveries?webhookId=:id&status=failed
```

Deliveries retry with backoff (1 minute, 5 minutes, 15 minutes, 1 hour, then every 6 hours) and are marked dead after 24 hours of failures. Check `/api/deliveries` for anything stuck. Setting `active: false` is not a pause: deliveries still queued for that endpoint are dead-lettered, and events while it is inactive are not queued, so nothing is replayed when you turn it back on.

## 3. Verify webhook signatures

Every webhook POST carries these headers:

- `X-Levy-Signature`: base64 Ed25519 signature over `{timestamp}.{deliveryId}.{event}.{raw body}`.
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
3. Reject the request if `X-Levy-Event` is not one of the event types listed above. Event names contain dots, and this check stops the signed text from being split at a different dot.
4. Build `{X-Levy-Timestamp}.{X-Levy-Delivery}.{X-Levy-Event}.{raw body}` and verify the base64 `X-Levy-Signature` over it with the public key. Reject on failure.
5. Drop the request if you already processed that `X-Levy-Delivery` id (the id is signed, so this is safe).

Example in Node.js:

```js
import { createPublicKey, verify } from "node:crypto";

const { publicKey } = await fetch(API + "/api/webhooks/public-key").then(r => r.json());
const key = createPublicKey(publicKey);
const EVENTS = new Set(["subscription.created", "subscription.updated", "charge.succeeded",
  "charge.failed", "dunning.started", "subscription.paused", "subscription.resumed",
  "subscription.cancelled", "invoice.ready", "allowance.low"]);

function isValid(rawBody, headers) {
  const ts = headers["x-levy-timestamp"];
  const event = headers["x-levy-event"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  if (!EVENTS.has(event)) return false;
  const signed = Buffer.from(`${ts}.${headers["x-levy-delivery"]}.${event}.${rawBody}`, "utf-8");
  return verify(null, signed, key, Buffer.from(headers["x-levy-signature"], "base64"));
}
```

`verifyDelivery` in `keeper/src/webhooks.ts` does the same checks.

Rotate your trust only when the public key endpoint returns a new key. Levy signs with one key per deployment.

## 4. Read invoices

Every successful charge is an invoice record: reference, amount, fee, transaction hash, block number, and charge count. The dashboard's "Export CSV" downloads them all; from your backend, use the same `Authorization` header as above (you only get your own):

```
GET /api/invoices
GET /api/invoices?subscription=3
GET /api/invoices?format=csv
```

The CSV download has the columns: `id,invoiceRef,subId,subscriber,merchant,amountUsdc,feeUsdc,txHash,blockNumber,chargeCount`. Amounts are decimal USDC (for example `10.000000`).

## 5. Dunning: what happens when a pull fails

A pull fails when the subscriber has insufficient USDC or has revoked the allowance. The contract never reverts on a failed pull; it records the failure on-chain and emits `ChargeFailed`, no sooner than the schedule below allows (anyone can call `charge()`, so the contract enforces the gaps: a stranger cannot pause a subscription any faster than the keeper would). From there:

1. The keeper retries per failure: after failure 1 it retries in 1 day, after failure 2 in 3 days, after failure 3 and beyond every 7 days. The contract enforces the same gaps (`retryGap`), so a deployment can configure longer ones (`LEVY_DUNNING_DAYS`) but not shorter.
2. When failures reach your plan's `maxFailed`, the subscription moves to `PAST_DUE`. It is still chargeable; the keeper keeps retrying.
3. At twice `maxFailed` failures, the contract pauses the subscription automatically. No further pulls happen until someone resumes it. Resuming starts a fresh retry run and bills from the resume date; the overdue cycle is not collected.
4. A successful pull at any point clears the failure count and the retry schedule. The next charge date moves forward one cycle from the missed one, so if more than one cycle was missed, the next charge is collected right away.

You receive `charge.failed` on every failure, `dunning.started` on the first failure, and `subscription.paused` if the contract auto-pauses. Use these to email the subscriber or flag the account in your own system; `docs/dunning-copy.md` has suggested wording and which event triggers each notice. Levy does not send subscriber emails; that is your layer.

A subscriber fixes a failed subscription by topping up USDC or approving more in the customer portal. The next scheduled retry (or a manual `charge` call) picks it up.

## 6. The subscriber flow

The easiest way: send the subscriber your checkout link, `https://<your Levy host>/checkout.html?plan=<planId>&ref=<reference>`. It shows the plan, connects their wallet, and walks them through the approval and the subscription (two wallet confirmations). Without a trial, the first cycle is charged right away.

`ref` is how you match the subscription to your own customer. It is stored with the subscription on-chain and included in every webhook (`ref` in the payload; `null` when none was given). It can be `0x` plus 64 hex digits, or up to 31 plain ASCII characters. Two rules:

- **It is public.** Anyone can read it on-chain, so never use an email, name or anything personal. Use an opaque id.
- **Whoever subscribes chooses it.** Someone could subscribe with another customer's reference and then cancel, making that customer look cancelled. Issue an unguessable reference per checkout (for example 32 random bytes you store against the customer), and once `subscription.created` links a reference to a customer, track that subscription by its `subId`.

To build your own flow instead, there are two ways to onboard:

**Direct approve (two transactions).** The subscriber:
1. Calls `approve` on the USDC contract for the `SubscriptionManager` address, for at least one cycle's price (more for a buffer).
2. Calls `subscribe(planId, ref)` on the `SubscriptionManager` (`ref` as above, or zero). Without a trial this charges the first cycle immediately, and fails if it can't.

**Permit2 (one transaction, after a one-time setup).** The subscriber must first have approved the Permit2 contract to spend their USDC (a one-time ERC-20 `approve`, shared with every app that uses Permit2). Then they sign an off-chain EIP-712 Permit2 message authorizing the `SubscriptionManager` to pull USDC (spender = the manager address, token = USDC). The subscriber then submits `subscribeWithPermit2(planId, ref, permitSingle, signature)` from the same wallet. One transaction, atomic. Only the signer can submit it. Uses Arc's Permit2 contract at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

## FAQ

**How do I reprice?**
Create a new plan with the new price and point new subscribers at it. Plans are immutable, so existing subscriptions keep the old price until the subscriber moves. There is no on-chain repricing.

**How do refunds work?**
Refunds are your policy and happen off-chain: send USDC back to the subscriber from your own wallet. The contract has no refund function, and cancelled subscriptions are terminal.

**How do I cancel a subscriber?**
Use Pause, Resume or Cancel on the subscription in your dashboard (each is a transaction from your wallet), or call `cancelSubscription(subId)` directly. Subscribers can do the same themselves: the customer portal (`/portal.html`) has Pause, Resume and Cancel buttons, and Change plan for moving to another of your plans. Cancellation is terminal; the subscription cannot be resumed. For a temporary stop, use `pauseSubscription` instead. Nothing is charged while paused. On `resumeSubscription`, if the next charge date has passed, billing restarts from the resume date; paused cycles are never billed. Days already paid for keep running during the pause.

**What does the 1% fee apply to?**
Each collected payment. The contract sends 99% to the merchant address on the plan and 1% to the FeeRouter in the same transaction. Failed pulls cost nothing.

**Who pays gas for charges?**
The keeper pays gas for the `charge` calls it submits. On Arc, gas is paid in USDC and costs are small. Charges are permissionless; the deployment's keeper is the always-on caller, so you do not need to run one yourself.

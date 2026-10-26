# Levy Merchant Guide

How to accept recurring USDC subscriptions on Arc with Levy.

The public version of this guide is `site/docs.html` (getlevy.xyz/docs.html), which adds a testnet quickstart with the deployed addresses, a backend sign-in section, an API reference table and one more FAQ answer. Change both together.

## Prerequisites

- A wallet with USDC on Arc (for gas and for receiving payments).
- The Levy API base URL from your deployment (the examples below show paths only; put your host in front, for example `https://app.getlevy.xyz` on testnet).
- The `SubscriptionManager` contract address for your deployment. The testnet addresses are in the README and on the public docs page; mainnet addresses are published at mainnet launch.

This guide describes manager v2 (`docs/manager-v2-design.md`), which is not deployed yet. The testnet contracts deployed on 2026-10-24 predate it: there `createPlan` takes `(price, cycleSeconds, trialSeconds, graceSeconds, maxFailed)`, and merchant accounts, retiring, cycle limits, intro prices and subscription transfers do not exist. v2 changes that at its deployment, under new addresses.

All USDC amounts in this guide are in 6-decimal units: 1 USDC = 1,000,000.

## 1. Create a plan

Plans live on-chain and their terms are immutable. Call `createPlan` on the `SubscriptionManager` contract, with the plan's terms as one tuple:

```
createPlan(
  account,         // address, the merchant account the plan belongs to: your own address to start
  (
    price,         // uint256, per-cycle price in 6-decimal USDC units
    cycleSeconds,  // uint256, billing cycle length in seconds
    trialSeconds,  // uint256, trial length in seconds (0 for none)
    maxFailed,     // uint8, failed pulls before the subscription goes PAST_DUE
    maxCycles,     // uint32, payments before the subscription completes (0 for no limit)
    introPrice,    // uint256, price of each intro payment (0 when introCycles is 0)
    introCycles,   // uint32, how many payments cost introPrice (0 for none)
    transferable   // bool, whether subscribers may move a subscription to another wallet
  )
)
```

The simplest way is the dashboard: sign in with the wallet that owns your
merchant account (at first, the wallet you create plans from) and use **New
plan** under Plans. It shows what customers will pay, checks the limits below,
and sends the transaction from your wallet. You can also call it directly (for
example with `cast send`). Rules the contract enforces: the caller must own
`account` (`NotOwner` otherwise), `price` above 0, `cycleSeconds` from 1 day
(86400) up to 10 years, `trialSeconds` shorter than `cycleSeconds`, `maxFailed`
from 1 to 255. With `introCycles` above 0, `introPrice` must be above 0 and below
`price`, and on a limited plan `introCycles` may not exceed `maxCycles`. With
`introCycles` at 0, `introPrice` must be 0. Any other value reverts `BadPlanParams`.

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

- `price`: what the subscriber pays each cycle once any intro payments are used up. Fixed at creation.
- `cycleSeconds`: how often the pull happens. "Monthly" is a fixed 30 days, so billing dates drift against calendar months.
- `trialSeconds`: the subscriber is not charged until the trial ends. Set to 0 to skip trials; the first cycle is then charged the moment they subscribe.
- `maxFailed`: how many failed pulls the subscription tolerates before the contract marks it `PAST_DUE`. At twice this number, the contract pauses the subscription automatically. A value of 2 or 3 fits most businesses.
- `maxCycles`: how many payments a subscription makes on this plan. The payment that reaches it moves the subscription to `COMPLETED`, which is final like `CANCELLED`, and its `nextChargeAt` then marks the end of the last paid cycle ("paid through"). 0 means no limit. 12 sells 12 installments or a fixed term. 1 with no trial is a one-time payment: subscribe collects it and completes the subscription in the same transaction. A limit is a cap, not a commitment: the subscriber can still cancel at any time.
- `introPrice` and `introCycles`: a subscription's first `introCycles` payments cost `introPrice` instead of `price`. A trial comes first and does not count. Intro pricing stays with the plan a subscription started on: after a plan change, the new plan bills its full price. It is per subscription, so a customer who cancels and subscribes again, from the same wallet or a new one, gets the intro price again. Check eligibility yourself, by `ref` and your own customer records, as you would for trials.
- `transferable`: whether a subscriber may move a subscription on this plan to another wallet (see the FAQ). Fixed at creation.

### Retiring a plan

`setPlanRetired(planId, true)` closes a plan to new customers: `subscribe`, `subscribeWithPermit2` and plan changes into it revert `RetiredPlan`, and the checkout page refuses its link. Existing subscribers keep paying as before and can still change out of it. `setPlanRetired(planId, false)` reopens it. Only the account's owner can call it. In the dashboard, use Retire or Reopen on the plan's row. A launch promotion is an intro plan that you retire when the promotion ends; its subscribers keep their terms.

### Your merchant account

The address that creates a plan for itself is a merchant account. The account address is permanent: plans, webhooks, the API and the `merchant` field of every webhook keep using it, and plan changes move subscribers only between plans of one account. Two settings hang off it:

- **Owner**: who acts for the account. The owner creates plans under it, pauses, resumes, cancels and retires, changes its settings and signs in to its dashboard. It starts as the account address itself. `ownerOf(account)` reads it.
- **Payout**: where the account's 99% goes. By default it follows the owner. `setPayout(account, payout)` from the owner fixes it at another address, such as a Safe or a treasury, from the next collection, and `setPayout(account, 0x0)` makes it follow the owner again. The manager's own address is refused (`BadPayout`). `payoutOf(account)` returns where payments go now, and `accountPayout(account)` the fixed address, or zero while payments follow the owner.

Handing the account to another wallet takes two steps: `transferOwnership(account, newOwner)` from the owner, then `acceptOwnership(account)` from the new owner, so a mistyped address never takes control. Proposing again replaces the proposal, and proposing `0x0` withdraws it. A fixed payout stays as it is; a payout that follows the owner moves to the new owner. From then on only the new owner can create plans under the account or act for it, and the previous owner loses the account's dashboard data and webhooks once Levy has indexed the handover. The dashboard's Merchant account panel does all of this, and the new owner accepts there.

If USDC blocklists your payout address, charges on your plans revert until you set a new payout. The first successful charge afterwards collects one cycle; if a whole cycle went by meanwhile, that charge starts a fresh cycle from that day, and the other missed cycles are never collected. A stolen owner key can redirect the payout and cancel subscriptions; making a Safe the owner, with a separate payout address, limits that, though a contract wallet cannot sign in to the dashboard or the API yet. Every change to the owner, the pending owner or the payout sends a `merchant.updated` webhook.

## 2. Register a webhook endpoint

Levy signs every billing event with Ed25519 and POSTs it to your URL. The easiest way to register one is the merchant dashboard: sign in with the wallet that owns your merchant account, open Webhooks, enter the URL under Add endpoint and click **Register webhook**.

From your own backend, sign in first with the wallet that owns your merchant account, which must be an ordinary wallet (contract wallets are not supported yet). The API README covers the three calls: challenge, wallet signature, verify. Every merchant endpoint takes an optional `merchant` (in the query string, or in the body for `POST /api/webhooks`) naming the account to act for. It defaults to the signed-in address, and the signed-in address must own the account now, or the API answers 403. Then send the session token:

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

Available event types. Every payload except `merchant.updated` carries `subId`,
`merchant` (your merchant account) and `ref` (your reference from subscribe, or
`null`), plus:

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
| `subscription.completed` | the last payment of a limited plan was collected and the subscription is `COMPLETED`: `txHash`, `blockNumber`. The payment itself is the `charge.succeeded` from the same transaction |
| `subscription.transferred` | the subscription moved to another wallet, which pays from now on: `from`, `to`, `txHash`, `blockNumber` |
| `allowance.low` | `subscriber`, `allowance`, `balance`, `cyclesCovered`, `nextChargeAt` |
| `merchant.updated` | your account's owner, pending owner or payout changed. No `subId` or `ref`: `merchant` (the account), `owner`, `payout` (`null` while payments follow the owner), `pendingOwner` (`null` when none), `txHash`, `blockNumber` |

`subscription.resumed` and `subscription.cancelled` have identical bodies, so
use the `X-Levy-Event` header (it is signed) or your endpoint URL to tell events apart.
`merchant.updated` carries the account's state as Levy read it when indexing the change.

`allowance.low` is your cue to email the customer before their payments start failing. The allowance is one pool shared by all of a subscriber's Levy subscriptions, so it runs down with every charge; the warning is sent once per subscription, and again only if the subscriber tops up and later runs low again. Levy prices the next charges as they will be billed (intro payments at the intro price), and a limited plan whose remaining payments are all covered is never low. Customers top up from the portal. Your dashboard's Allowance column shows the same thing. Only direct USDC approvals count, not Permit2 allowances, so a subscriber who used Permit2 is flagged low right after subscribing.

Manage endpoints with the API (same `Authorization` header; you only ever see your own account's, and `?merchant=<account>` picks another account you own):

```
GET    /api/webhooks
DELETE /api/webhooks/:id
PATCH  /api/webhooks/:id        {"active": false}
GET    /api/deliveries?webhookId=:id&status=failed
```

Deliveries retry with backoff (1 minute, 5 minutes, 15 minutes, 1 hour, then every 6 hours). A delivery whose next retry would pass 24 hours of age is marked dead instead, so the last attempt comes about 19 hours 21 minutes after the first and nothing is tried after that. Check `/api/deliveries` for anything stuck: `status` is `pending`, `sent`, `failed` (waiting for its next retry) or `dead` (given up). Setting `active: false` is not a pause: deliveries still queued for that endpoint are dead-lettered, and events while it is inactive are not queued, so nothing is replayed when you turn it back on.

## 3. Verify webhook signatures

Every webhook POST carries these headers:

- `X-Levy-Signature`: base64 Ed25519 signature over `{timestamp}.{deliveryId}.{webhookId}.{event}.{raw body}`.
- `X-Levy-Timestamp`: unix seconds when this attempt was signed (retries get a fresh one).
- `X-Levy-Delivery`: the delivery id, 16 hex digits, a dash and a number (for example `9f3c1a2b4d5e6f70-42`). It is the same across retries of one delivery and never reused. Store it and ignore repeats.
- `X-Levy-Webhook`: the id of the endpoint this delivery was made for. Your endpoint's id is returned when you register it and shown in the dashboard's Webhooks table.
- `X-Levy-Key-Id`: which signing key was used (matches `keyId` below).
- `X-Levy-Event`: the event type, e.g. `charge.succeeded`.

One key signs deliveries for every merchant, so a valid signature alone only proves Levy sent the delivery, not that it was sent to you. Checking it against your own webhook id (step 4) and your own address (step 6) is what stops someone forwarding you a delivery made for their endpoint, such as a 1-unit payment to a plan of their own made with your customer's reference.

Fetch the public key:

```
GET /api/webhooks/public-key
```

The response includes the SPKI PEM public key, its `keyId`, and the algorithm (`ed25519`).

Verification steps:

1. Read the raw request body exactly as received (before JSON parsing).
2. Reject the request if `X-Levy-Timestamp` is more than 5 minutes from your clock. A captured delivery then cannot be replayed later.
3. Reject the request if `X-Levy-Event` is not one of the event types listed above, or if `X-Levy-Delivery` is not 16 hex digits, a dash and a number. Event names contain dots, and these checks stop the signed text from being split at a different dot.
4. Build `{X-Levy-Timestamp}.{X-Levy-Delivery}.{your webhook id}.{X-Levy-Event}.{raw body}` and verify the base64 `X-Levy-Signature` over it with the public key. Use the id you stored for this endpoint, not the `X-Levy-Webhook` header. Reject on failure.
5. Drop the request if you already processed that `X-Levy-Delivery` id (the id is signed, so this is safe).
6. After parsing, reject the event if `merchant` is not your own merchant account, and act on a subscription only if its `planId` is one of your plans.

Example in Node.js:

```js
import { createPublicKey, verify } from "node:crypto";

const API = "https://your-levy-host"; // your Levy API base URL
const WEBHOOK_ID = "1"; // this endpoint's id, from registration or the dashboard
const { publicKey } = await fetch(API + "/api/webhooks/public-key").then(r => r.json());
const key = createPublicKey(publicKey);
const EVENTS = new Set(["subscription.created", "subscription.updated", "charge.succeeded",
  "charge.failed", "dunning.started", "subscription.paused", "subscription.resumed",
  "subscription.cancelled", "invoice.ready", "allowance.low", "subscription.completed",
  "subscription.transferred", "merchant.updated"]);

function isValid(rawBody, headers) {
  const ts = headers["x-levy-timestamp"];
  const event = headers["x-levy-event"];
  const delivery = headers["x-levy-delivery"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  if (!EVENTS.has(event) || !/^[0-9a-f]{16}-[0-9]+$/.test(delivery)) return false;
  const signed = Buffer.from(`${ts}.${delivery}.${WEBHOOK_ID}.${event}.${rawBody}`, "utf-8");
  return verify(null, signed, key, Buffer.from(headers["x-levy-signature"], "base64"));
}
```

`verifyDelivery` in `keeper/src/webhooks.ts` does steps 2 to 4 (pass it your webhook id). It does not remember delivery ids or know your address, so do steps 5 and 6 yourself.

Before 2026-10-24 the signature covered `{timestamp}.{deliveryId}.{event}.{raw body}` and delivery ids were plain row numbers that started again at 1 when Levy's database was recreated. Receivers written for that format must be updated.

Rotate your trust only when the public key endpoint returns a new key. Levy signs with one key per deployment.

## 4. Read invoices

Every successful charge is an invoice record: reference, amount, fee, transaction hash, block number, and charge count. The dashboard's "Export CSV" downloads them all; from your backend, use the same `Authorization` header as above (you only get your own account's; add `merchant=<account>` for another account you own):

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
3. At twice `maxFailed` failures, the contract pauses the subscription automatically. No further pulls happen until the subscriber resumes it in the portal. You cannot resume an auto-pause (the contract reverts `NotSubscriber`); your dashboard shows "customer resumes" instead of a Resume button. Resuming starts a fresh retry run and bills from the resume date; the overdue cycle is not collected.
4. A successful pull at any point clears the failure count and the retry schedule, and starts a fresh cycle on the day it succeeds. The billing date moves to the recovery date, and the late days are not billed: one cycle is collected, however long the payment was failing.

You receive `charge.failed` on every failure, `dunning.started` on the first failure, and `subscription.paused` if the contract auto-pauses. Use these to email the subscriber or flag the account in your own system; `docs/dunning-copy.md` has suggested wording and which event triggers each notice. Levy does not send subscriber emails; that is your layer.

A subscriber fixes a failed subscription by topping up USDC or approving more in the customer portal. The next scheduled retry (or a manual `charge` call) picks it up.

## 6. The subscriber flow

The easiest way: send the subscriber your checkout link, `https://<your Levy host>/checkout.html?plan=<planId>&ref=<reference>`. It shows the plan with its intro price and number of payments, connects their wallet, and walks them through the approval and the subscription (two wallet confirmations). Without a trial, the first cycle is charged right away. The approval covers the payments the subscriber chooses, intro payments at the intro price, and never more than a limited plan's payments. A retired plan's link shows that the plan is closed.

`ref` is how you match the subscription to your own customer. It is stored with the subscription on-chain and included in every webhook (`ref` in the payload; `null` when none was given). It can be `0x` plus 64 hex digits, or up to 31 printable ASCII characters, which are left-aligned and zero-padded. The webhook payload always carries it as `0x` plus 64 lowercase hex digits, so `cust42` arrives as `0x637573743432` followed by zeros; decode it up to the first zero byte. Two rules:

- **It is public.** Anyone can read it on-chain, so never use an email, name or anything personal. Use an opaque id.
- **Whoever subscribes chooses it.** Someone could subscribe with another customer's reference and then cancel, making that customer look cancelled. Issue an unguessable reference per checkout (for example 32 random bytes you store against the customer), and once `subscription.created` links a reference to a customer, track that subscription by its `subId`.

To build your own flow instead, there are two ways to onboard:

**Direct approve (two transactions).** The subscriber:
1. Calls `approve` on the USDC contract for the `SubscriptionManager` address, for at least the first payment (the intro price, if the plan has one), and more for later cycles.
2. Calls `subscribe(planId, ref)` on the `SubscriptionManager` (`ref` as above, or zero). Without a trial this charges the first cycle immediately, and fails if it can't.

**Permit2 (one transaction, after a one-time setup).** The subscriber must first have approved the Permit2 contract to spend their USDC (a one-time ERC-20 `approve`, shared with every app that uses Permit2). Then they sign an off-chain EIP-712 Permit2 message authorizing the `SubscriptionManager` to pull USDC (spender = the manager address, token = USDC). The subscriber then submits `subscribeWithPermit2(planId, ref, permitSingle, signature)` from the same wallet. One transaction, atomic. Only the signer can submit it. Uses Arc's Permit2 contract at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

## FAQ

**How do I reprice?**
Create a new plan with the new price, point new subscribers at it, and retire the old plan so its link stops taking sign-ups. Plan terms are immutable, so existing subscriptions keep the old price until the subscriber moves. There is no on-chain repricing.

**How do refunds work?**
Refunds are your policy and happen off-chain: send USDC back to the subscriber from your own wallet. The contract has no refund function, and cancelled and completed subscriptions are terminal.

**How do I cancel a subscriber?**
Use Pause, Resume or Cancel on the subscription in your dashboard (each is a transaction from the wallet that owns your account), or call `cancelSubscription(subId)` directly. You can resume only a pause you made yourself; a pause by the subscriber, or an auto-pause after failed payments, is theirs to resume, and the dashboard shows "customer resumes" there. Subscribers can do the same themselves: the customer portal (`/portal.html`) has Pause, Resume and Cancel buttons, and Change plan for moving to another of your plans that is not retired. Cancellation is terminal; the subscription cannot be resumed. For a temporary stop, use `pauseSubscription` instead. Nothing is charged while paused. On `resumeSubscription`, if the next charge date has passed, billing restarts from the resume date; paused cycles are never billed. Days already paid for keep running during the pause. A completed subscription can no longer be paused, resumed or cancelled.

**Can a subscriber move a subscription to a new wallet?**
Only on a plan created with `transferable` set. The subscriber calls `proposeTransfer(subId, newWallet)`, then the new wallet calls `acceptTransfer(subId, planId)` with the subscription's current plan, so the plan cannot be switched in between. Proposing again replaces the offer, and `0x0` withdraws it. The portal has Move to another wallet and, signed in as the new wallet, Accept. The subscription keeps its id, plan, `ref`, paid time, credit and dunning state; later payments pull from the new wallet's allowance, and with none there, dunning starts as usual. Only the subscriber can propose, and only the proposed wallet can accept, so neither you nor anyone else can make a wallet pay without its own acceptance. A cancelled or completed subscription cannot move. You receive `subscription.transferred`; keep tracking the subscription by `subId`. A customer who lost their wallet cannot move the subscription: they subscribe again from a new one.

**What does the 1% fee apply to?**
Each collected payment. The contract sends 99% to the payout address of the plan's merchant account (the owner, unless you set a payout) and 1% to the FeeRouter in the same transaction. Failed pulls cost nothing.

**Who pays gas for charges?**
The keeper pays gas for the `charge` calls it submits. On Arc, gas is paid in USDC and costs are small. Charges are permissionless; the deployment's keeper is the always-on caller, so you do not need to run one yourself.

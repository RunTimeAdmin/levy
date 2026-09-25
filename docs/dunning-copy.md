# Levy Dunning Copy

Customer-facing copy for subscription payment states. Levy does not email
subscribers: merchants send these notices (email, in-app) from their own
systems, triggered by Levy webhooks. Each notice lists its trigger and where
each placeholder comes from.

Copy rules: short sentences, no blame, no jargon, one action per notice.

**Placeholders**
- `{amount}`: the plan price, `priceUsdc` from `GET /api/subscriptions/:id`
  (not in the webhook payloads).
- `{n}`: `failedAttempts` from the `charge.failed` payload.
- `{days}`: days until the next retry, from `nextRetryAt` (in the
  `dunning.started` payload for the first failure; from
  `GET /api/subscriptions/:id` → `dunning.nextRetryAt` after that).
- `{portal_url}`: `https://<your Levy host>/portal.html`, where the subscriber
  can top up their approval and resume.
- `maxFailed` for the plan: `GET /api/plans`.

## 1. First failed charge

Trigger: `charge.failed` with `failedAttempts = 1` (arrives with `dunning.started`).

Subject: Your subscription payment did not go through

> We tried to collect your subscription payment of {amount} USDC and it did not go through. This usually means the wallet is short on USDC, or the spending approval has run out or was removed.
>
> We will try again in {days} days. To avoid interruption, top up USDC or approve more in your subscription portal: {portal_url}

## 2. Retry scheduled

Trigger: `charge.failed` with `failedAttempts` of 2 or more, unless it is also
the auto-pause (see 4: skip this notice when a `subscription.paused` with
`auto: true` arrives for the same subscription and transaction).

Subject: We will retry your subscription payment

> Your subscription payment of {amount} USDC is still outstanding after {n} attempts. We will try again in {days} days.
>
> Top up USDC or approve more in your subscription portal to clear this before the next attempt: {portal_url}

## 3. Past due

Trigger: `charge.failed` with `failedAttempts` equal to the plan's `maxFailed`.
(There is no separate past-due event; the contract marks the subscription
PAST_DUE at that failure.)

Subject: Your subscription is past due

> Your subscription is past due after {n} failed payment attempts. It stays active for now, and we will keep retrying on schedule.
>
> Top up USDC or approve more in your subscription portal to bring it current: {portal_url}

## 4. Auto-paused

Trigger: `subscription.paused` with `auto: true` (the contract paused it after
`2 × maxFailed` failures). `subscription.paused` with `auto: false` is a pause
the subscriber or merchant chose; do not send this notice for it.

Subject: Your subscription is paused

> Your subscription was paused after {n} failed payment attempts. No further charges will be attempted until it is resumed.
>
> To restart: top up USDC or approve more, then resume the subscription in your portal: {portal_url}. Billing restarts from the day you resume. Your merchant can also resume it for you.

## 5. Successful retry

Trigger: `charge.succeeded` for a subscription that had failed before (you
sent notice 1 for it).

Subject: Your subscription payment went through

> Your payment of {amount} USDC was collected successfully and the retry schedule is cleared.
>
> If more than one payment was missed, the next one is collected right away.

## 6. Approval running low

Trigger: `allowance.low` (the subscriber's approval covers fewer than 2 more
rounds of their Levy subscriptions; `cyclesCovered` in the payload). Sent once;
again only after they top up and later run low again.

Subject: Your subscription approval is running low

> Your USDC approval for subscription payments covers {cyclesCovered} more payment(s). When it runs out, payments will stop going through.
>
> Approve more in your subscription portal to keep your subscription running: {portal_url}

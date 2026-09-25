# Levy Dunning Copy

Customer-facing copy for subscription payment states. These lines are surfaced to subscribers through merchant integrations (email, in-app notices) driven by Levy webhook events. Each notice maps to the webhook event in parentheses.

Copy rules followed: short sentences, no blame, no jargon, one action per notice.

## 1. First failed charge (charge.failed + dunning.started)

Subject: Your subscription payment did not go through

> We tried to collect your subscription payment of {amount} USDC and it did not go through. This usually means the wallet is short on USDC or the spending approval was removed.
>
> We will try again in {days} days. To avoid interruption, top up USDC or re-approve spending for the Levy contract before then.

## 2. Retry scheduled (charge.failed, attempt 2+)

Subject: We will retry your subscription payment

> Your subscription payment of {amount} USDC is still outstanding after {n} attempts. We will try again in {days} days.
>
> Top up USDC or re-approve spending for the Levy contract to clear this before the next attempt.

## 3. Past due (subscription marked PAST_DUE on-chain)

Subject: Your subscription is past due

> Your subscription is past due after {n} failed payment attempts. It stays active for now, and we will keep retrying on schedule.
>
> Add USDC or re-approve spending for the Levy contract to bring it current.

## 4. Auto-paused (subscription.paused)

Subject: Your subscription is paused

> Your subscription was paused after {n} failed payment attempts. No further charges will be attempted until it is resumed.
>
> To restart: top up USDC, re-approve spending for the Levy contract, and resume the subscription from your account. Your merchant is also able to resume it for you.

## 5. Successful retry (charge.succeeded after failures)

Subject: Your subscription payment went through

> Your payment of {amount} USDC was collected successfully. Your subscription is current and the retry schedule is cleared.
>
> No action needed.

---

## Copy review against the style guide

Checked every line above against ~/memory/communication-style.md (2026-09-25).

Banned words scanned: leverage, foster, ignite, empower, uncover, unleash, underscore, streamline, seamless, robust, comprehensive, innovative, transformative, elevate, utilize, dive deep, tapestry, illuminate, pivotal, intricate, elucidate, hence, harness, groundbreaking, cutting-edge, remarkable, landscape, realm, journey, testament, boost, can, may, just, that, very, really, literally, actually, certainly, probably, basically, could, maybe, delve, embark, enlightening, esteemed, shed light, craft, crafting, imagine, game-changer, unlock, discover, skyrocket, abyss, revolutionize, disruptive, unveil.

Result: zero hits. No banned words appear in the copy.

Other checks:

- No em dashes anywhere in the document.
- No semicolons in the customer-facing copy.
- No asterisks used for emphasis in the copy blocks.
- No hype, no blame language ("usually means the wallet is short" states the two mechanical causes without accusing).
- No "No X. No Y. Just Z." pattern.
- No sentence-opening "However"; no "Moreover" or "Furthermore".
- Placeholders ({amount}, {days}, {n}) are marked for merchant templating and contain no banned words.

Certified clean.

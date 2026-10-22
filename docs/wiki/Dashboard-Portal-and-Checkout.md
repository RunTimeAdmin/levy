# Dashboard, Portal and Checkout

The API serves three browser pages: a merchant dashboard, a customer portal and a checkout page. They are plain HTML, JavaScript and one stylesheet, with no framework, build step or third-party code. They read from the API and write to the chain, and every write is a transaction the user signs in their own wallet. The API holds no on-chain key; the only thing the pages ask it to change is webhook configuration.

Amounts are USDC with 6 decimals (1 USDC = 1,000,000 units). The pages show exact amounts: cents, plus further digits only when they are not zero.

## The three pages

| Page | URL | For | Signs in | On-chain actions |
|---|---|---|---|---|
| Merchant dashboard | `/` | A merchant | Yes | `createPlan`, pause, resume, cancel |
| Customer portal | `/portal.html` | A subscriber | Yes | pause, resume, cancel, `changePlan`, allowance top-up and revoke |
| Checkout | `/checkout.html?plan=<id>&ref=<ref>` | Anyone with a merchant's link | No | `approve`, `subscribe` |

Dashboard and portal sign in with the wallet ([Authentication.md](Authentication.md)); checkout reads only the public `/api/config` and `/api/plans`. The shared scripts in `/public/` are `wallet.js` (`LevyWallet`: chain switching, `eth_call` reads, transaction sending, hand-encoded calls whose selectors `api/test/wallet.test.ts` checks against the contract ABI), `format.js` (`LevyFormat`: amounts, addresses, dates, cycle names and links, shared by the three pages), `auth.js` (sign-in), `network.js` (testnet bar) and `app.css`, plus one controller per page.

## On-chain actions

| Action | Page | Call | Contract allows |
|---|---|---|---|
| Create plan | Dashboard | `createPlan(price, cycleSeconds, trialSeconds, 0, maxFailed)` | Anyone; the sender becomes the plan's merchant |
| Approve allowance | Checkout, portal | `approve(manager, total)` on the USDC contract | The USDC holder |
| Subscribe | Checkout | `subscribe(planId, ref)` | The subscriber |
| Pause, resume, cancel | Dashboard, portal | `pauseSubscription`, `resumeSubscription`, `cancelSubscription` | The subscriber or the plan's merchant |
| Change plan | Portal | `changePlan(subId, newPlanId)` | The subscriber only, to another plan of the same merchant, while trial, active or past due |

The `graceSeconds` argument is informational on-chain and the pages send 0. Balance, allowance and the manager's `subscriptions(subId)` getter are read through the wallet as `eth_call`.

`LevyWallet.connect` requests the account, switches the wallet to the configured chain (adding the Arc network if the wallet lacks it) and re-checks the chain id. The dashboard and portal then refuse to send from any account other than the signed-in one. A transaction goes out with `eth_sendTransaction` and its receipt is polled once a second for up to two minutes. The result is confirmed, reverted (nothing changed) or unknown (no receipt yet, which is not the same as failed).

## Merchant dashboard

- **Metric cards.** MRR, active subscriptions, charge success rate, dunning queue length, total collected, past due and paused counts.
- **Plans.** The merchant's plans with price, trial, failed payments before past due, live subscriber count and a copyable checkout link. Adding `&ref=` and an id of up to 31 characters tags a customer.
- **New plan.** Price in USDC (up to 6 decimals), cycle (daily, weekly, 30, 90 or 365 days, or custom from 1 to 3650), trial days (shorter than the cycle), failed payments before past due (1 to 255). A summary states what customers pay, that a subscription pauses after twice that many failures, and Levy's 1% share. Plans are immutable. The plan id comes from the `PlanCreated` log, and the page polls `/api/plans` every 5 seconds for up to 90 seconds until the keeper's index has the plan.
- **Subscriptions.** Subscriber, reference (readable if ASCII, else shortened hex), plan, price, status, next charge, failed attempts and allowance runway (`low: N`, `N cycles` or `not checked`). Pause and Cancel while trial, active or past due; Resume and Cancel while paused; nothing once cancelled. Each asks for confirmation, then a signature, then updates its row at once; the rest follows the keeper's next sync.
- **Dunning queue.** Subscription, subscriber, attempts, next retry (UTC).
- **Webhooks.** Endpoints with latest delivery status, a log of the last 20 deliveries, Enable or Disable (confirmed first, because queued deliveries are dropped) and Delete. Adding takes an https URL and the ten event types, all ticked by default. Limits are in [API-Reference.md](API-Reference.md).
- **Invoices.** The latest 50 charges with explorer links. "Export CSV" fetches `/api/invoices?format=csv` with the session and saves `levy-invoices.csv`.

## Customer portal

The allowance panel comes first, then one card per subscription: status, plan, price, next charge (none once cancelled), failed attempts, merchant and invoice history. Pause, Resume and Cancel follow the dashboard's rules. Cancel is final, and refunds are the merchant's decision off-chain. "Change plan" appears for trial, active and past due subscriptions when the merchant has another plan.

**Plan change quote.** Before the wallet is involved, the portal reads the subscription from the contract and applies the contract's own arithmetic: unused time on a paid cycle becomes credit, the new plan's first cycle is paid from credit first, and the rest is pulled now. The panel states what is due, what carries over and the next charge date, and keeps the switch button disabled if the allowance would not cover it. See [Plan-Changes-and-Proration.md](Plan-Changes-and-Proration.md).

**Allowance panel.** All of a subscriber's Levy subscriptions draw on one USDC allowance. The panel shows that pool: approved amount, how many rounds of all their charges it covers, and balance, in a warning style when the allowance is low or the balance is under one round. Figures come from `/api/funds`, as of the keeper's last check. Only direct USDC allowances count, so a Permit2 subscriber shows as low ([Permit2.md](Permit2.md)).

- **Top up** adds a chosen number of rounds (1 to 120, default 12) times the per-round amount to the allowance read from the chain at click time.
- **Revoke** sets it to 0 after a warning that every Levy subscription will then fail to charge. To stop one subscription, cancel it.

## Checkout

The plan comes from the URL and the subscriber is whoever connects a wallet.

```mermaid
sequenceDiagram
    participant Customer
    participant Page
    participant API
    participant Wallet
    participant USDC
    participant Manager
    Customer->>Page: "Open checkout link"
    Page->>API: "GET /api/config and GET /api/plans"
    API-->>Page: "Chain, contract addresses, plan"
    Customer->>Page: "Connect wallet"
    Page->>Wallet: "Switch to the Levy chain, read balance and allowance"
    Customer->>Page: "Approve and subscribe"
    Page->>Wallet: "Step 1, approve current allowance plus price times cycles"
    Wallet->>USDC: "approve with the Manager as spender"
    Page->>Page: "Save the transaction hash in localStorage"
    Page->>Wallet: "Step 2, subscribe with plan id and ref"
    Wallet->>Manager: "subscribe"
    Manager-->>Page: "Receipt with the Subscribed event"
    Page->>Customer: "Show the receipt"
```

1. **The link.** `plan` must be digits. `ref` is optional: `0x` plus 64 hex digits, or 1 to 31 printable ASCII characters, left-aligned and zero-padded to 32 bytes. An invalid `ref` stops the page rather than subscribing with the wrong one.
2. **The plan card.** Price, cycle, when the first charge happens (today, or after the trial), the merchant's address, the reference, the Levy contract and the network. It shows an address, not a verified name.
3. **Allowance.** The customer picks how many cycles to approve, 1 to 120, default 12, with the USDC total shown live. A note explains it is a ceiling shared by all their Levy subscriptions, and the contract limits each charge to the plan's price once per cycle, paid to that merchant.
4. **Connect.** Shows the account, USDC balance and current Levy allowance. With no trial and a balance below the first charge, it says so and, on testnet, links to the faucet.
5. **Approve and subscribe.** Step 1 reads the current allowance and sends `approve(manager, current + price x cycles)`. This adds to the existing allowance instead of replacing it, so other subscriptions keep their runway. The total is fixed when sent and `approve` sets the allowance to it, so repeating the same approval changes nothing. Step 2 sends `subscribe(planId, ref)`. Without a trial it also pays the first cycle, and a failed payment reverts the subscribe.
6. **Receipt.** Subscription id and first charge time from the `Subscribed` log, what was paid today, the next charge date, allowance left (in charges at this price), the transaction as an explorer link and a link to the portal. The transaction is the on-chain record.

### Transaction recovery

A second subscribe after an uncertain outcome would create a second paid subscription, so checkout never sends one blind.

- **Pending record.** As soon as the wallet returns a hash, the page saves `{approveTarget, approveHash, subscribeHash, at}` in `localStorage` under `levy-checkout:<chainId>:<planId>:<account>`. It lasts 24 hours and is removed on success.
- **On reconnect** the page settles the record before offering anything. A confirmed subscribe goes to the receipt, a confirmed approval moves to step 2 (the button reads "Subscribe"), and a reverted transaction is forgotten so the customer can try again.
- **Unknown outcome.** With no receipt after two minutes, or on a reload before one exists, the page warns not to pay again, links the explorer and offers "Check again". Subscribe stays disabled until a receipt says how it ended.
- **Within a session**, a failed subscribe after a good approval does not approve again, and the cycles field locks once an approval is sent.

```mermaid
flowchart TD
    A["Wallet returns a transaction hash"] --> B["Save the hash in localStorage"]
    B --> C{"Receipt within two minutes?"}
    C -->|"confirmed"| D["Next step, or the receipt"]
    C -->|"reverted"| E["Forget the hash and allow a retry"]
    C -->|"none yet"| F["Subscribe stays disabled"]
    F --> G["Check again reads the receipt"]
    G --> C
```

## Testnet bar

On every page `network.js` reads `/api/config` and, when the chain id is not 5042 (treated as mainnet), shows a bar under the header: "Arc Testnet: test USDC only, no real money moves." On Arc testnet (5042002) it links Circle's faucet. If the call fails the bar stays hidden.

## Content-Security-Policy

HTML responses carry this policy, plus `x-frame-options: DENY`, `cross-origin-opener-policy: same-origin` and a `permissions-policy` that turns off camera, microphone, geolocation, payment and USB:

```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Scripts load only from the app's own origin and never inline, so an injected `<script>` or event-handler attribute cannot run and act with the session. That is why each page's logic lives in `/public/*.js` and handlers are attached from code. The session cookie is HttpOnly as well. Pages can fetch only their own origin and cannot be framed. Inline styles stay allowed because a style cannot run code. Wallet extensions inject their provider as content scripts, which a page's CSP does not govern. On the dashboard, strings a sender controls (webhook URLs, event names, error text, references) are escaped before reaching `innerHTML`. Scripts and the stylesheet are served without these headers.

## Styling

`app.css` is the one shared stylesheet. It declares the palette as CSS custom properties on `:root` (`--bg`, `--card`, `--text`, `--muted`, `--accent`, `--accent-2`, `--border`, `--radius`, plus `--warn`, `--bad` and `--mono`, which `site/style.css` does not define) and mirrors the marketing site's colors, type and buttons, so the app reads as the same dark product. It uses system fonts and no dependencies. Components are a few classes: panels and cards, buttons (primary, `.ghost`, `.danger`, `.small`), status pills (green for trial, active and sent; amber for past_due, failed and pending; red for paused, cancelled and dead), scrolling tables, a banner, a spinner and skeletons. One 640px breakpoint stacks the header into two rows, and `prefers-reduced-motion` stops animation. Each HTML file adds a small inline `<style>` block for its own layout, which the policy allows.

## Known limitations

The first two are open items 7 and 8 in SECURITY_REVIEW.md section 9 (see [Security.md](Security.md)).

- **Checkout recovery is per browser and short-lived (item 7).** A second tab that connected before the first tab broadcast does not stop at the pending record: its confirm handler loads the record but never checks `subscribeHash`. The record expires after a day and is lost if storage is blocked. The planned fix keeps the order longer, coordinates tabs and reconciles with the chain before offering another subscribe. Repeat subscriptions per wallet and plan can be legitimate, so they are not banned.
- **Portal top-up can repeat (item 8).** It adds rounds to the allowance it reads at click time and re-enables its buttons after an unknown outcome. An approval that mined but whose receipt could not be read can be topped up twice. Only the allowance changes; no funds move. The planned fix stores the target total, as checkout does.
- The wallet's network is checked at connect, not again before each transaction (item 11).
- Checkout shows the merchant's address with no verified identity, and has no Permit2 path although the contract supports `subscribeWithPermit2`.
- API data is as of the keeper's last sync; after a confirmed transaction the pages update the affected row themselves.
- Levy runs on Arc testnet only and is not audited; each page footer says so.

## Source files

- [api/public/index.html](https://github.com/RunTimeAdmin/levy/blob/main/api/public/index.html), [api/public/portal.html](https://github.com/RunTimeAdmin/levy/blob/main/api/public/portal.html), [api/public/checkout.html](https://github.com/RunTimeAdmin/levy/blob/main/api/public/checkout.html)
- [api/public/dashboard.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/dashboard.js), [api/public/portal.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/portal.js), [api/public/checkout.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/checkout.js)
- [api/public/wallet.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/wallet.js), [api/public/format.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/format.js), [api/public/auth.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/auth.js), [api/public/network.js](https://github.com/RunTimeAdmin/levy/blob/main/api/public/network.js), [api/public/app.css](https://github.com/RunTimeAdmin/levy/blob/main/api/public/app.css)
- [api/src/server.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/server.ts)
- [api/test/wallet.test.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/test/wallet.test.ts)
- [SECURITY_REVIEW.md](https://github.com/RunTimeAdmin/levy/blob/main/SECURITY_REVIEW.md)
- [docs/merchant-guide.md](https://github.com/RunTimeAdmin/levy/blob/main/docs/merchant-guide.md)

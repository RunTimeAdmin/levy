# Security

This page covers Levy's trust and threat model, the controls in the code, what the reviews found and what is still open. Levy runs on Arc testnet only, nothing is on mainnet, nothing has been externally audited and no real money flows through it. The contracts never hold funds at rest. Where `SECURITY_REVIEW.md`, `FEE_MATH_AUDIT.md` and the code disagree, the code wins. The page describes manager v2 ([design](https://github.com/RunTimeAdmin/levy/blob/main/docs/manager-v2-design.md)), which adds merchant accounts, retired plans, cycle limits, intro prices and subscription transfers; the testnet contracts from 2026-10-24 predate it, and the reviews below looked at the code before v2.

## Trust model

- **Anyone** can call `charge()` and `sweep()`, create plans for their own account and subscribe as themselves. They cannot pull anything but a subscriber's pre-approved USDC, send it anywhere but the payout of the plan's merchant account and the FeeRouter, charge early, record failures faster than `retryGap`, subscribe someone else, or make another wallet pay for a subscription.
- **Merchant account owners** control the account's plans (terms immutable, retirement reversible), its payout address and its ownership. They can pause or cancel subscriptions on its plans, and resume a pause the merchant made. They cannot change a price, pull more than it, move a subscriber to another account's plan, or move a subscription to another wallet. A merchant cannot resume a pause its subscriber made or a dunning auto-pause (`NotSubscriber`), so a subscriber's pause holds until the subscriber resumes. Before the fix for finding M-1 of the 2026-10-24 review, a merchant could resume either. A key that handed the account on keeps none of these powers.
- **Subscribers** can pause, resume (any pause), cancel, switch to another plan of the same account that is not retired, move the subscription to another wallet on a transferable plan, and revoke the allowance at any time. They are never charged more than the plan price (or its intro price) per cycle, more than a limited plan's cycles, or more than the allowance.
- **The keeper operator** holds a gas key and the webhook signing key and runs the database. The contracts give the keeper no role: it cannot take user funds or alter plans, only fail to charge or misreport.
- **Arc, USDC and Permit2** are trusted external dependencies.

## Why a permissionless `charge()` is safe

`charge(subId)` loads the subscription and plan from storage, which the caller cannot influence. The amount due is the cycle's price (the intro price during intro cycles) minus credit, and credit only comes from cycles that were paid, at the price they were billed at. The pull moves USDC from the subscriber to the manager, never to the caller, and the manager pays the payout of the plan's merchant account (which only that account's owner can set) and the FeeRouter (immutable) in the same transaction, so it keeps no balance (`invariant_managerHoldsNothing`). Before `nextChargeAt`, or on a paused, cancelled or completed subscription, the call reverts `NotChargeable`. The v2 state it can write (the cycle count, intro cycles left, the billed price and completion) changes only on a successful, due collection that pays the merchant. Front-running changes nothing. The one thing a caller controls is when a failing pull is recorded, which the contract spaces out (see Dunning).

## Reentrancy and checks-effects-interactions

`subscribe`, `subscribeWithPermit2`, `charge` and `changePlan` are `nonReentrant`, which covers every path that calls USDC or Permit2; outgoing transfers use SafeERC20. These paths write `nextChargeAt`, `failedAttempts`, `status`, `chargeCount` and the v2 billing state after the transfers, so they do not follow checks-effects-interactions. With standard USDC, which has no transfer callbacks, no reentrant path exists and the guard is defence in depth. Pause, resume, cancel, `setPlanRetired`, the account functions and the transfer functions are unguarded and only write storage, so with a token that made callbacks a cancel issued inside `changePlan`'s transfer would be overwritten by `status = ACTIVE`. This is open for the auditor; reorder if the token ever changes.

## Access control

| Function | Who | Note |
|---|---|---|
| `createPlan(account, terms)` | the current owner of `account` | no shortcut for the account's own address once it handed ownership on |
| `setPlanRetired` | the owner of the plan's account | stops new subscriptions and plan changes into the plan |
| `setPayout` | the account's owner | one step; the manager's own address is refused |
| `transferOwnership`, `acceptOwnership` | the account's owner, then the proposed owner | two steps, so a mistyped address never takes control |
| `subscribe` | anyone, as themselves | `ref` is public and caller-chosen |
| `subscribeWithPermit2` | the permit signer only | spender and token checked before `permit()` |
| `charge` | anyone | see above |
| `pauseSubscription`, `cancelSubscription` | subscriber or the owner of the plan's account | a merchant pause sets `pausedByMerchant` |
| `resumeSubscription` | subscriber; the account's owner only for the merchant's own pause | resume is a fresh start |
| `changePlan` | subscriber only | same-account plans that are not retired |
| `proposeTransfer` | subscriber only | transferable plans only |
| `acceptTransfer` | the proposed wallet only | names the current plan |
| `FeeRouter.sweep` | anyone | destination fixed to `treasury` |
| `FeeRouter.proposeTreasury` | current treasury only | accepts any non-zero address; sets `pendingTreasury` |
| `FeeRouter.acceptTreasury` | the pending treasury only | completes the move |

The manager has no admin function, pause switch or upgrade path; merchant account owners control only their own account. Plan terms are immutable, so there is no repricing attack after a subscriber approves; a new price means a new plan that the subscriber must choose with `changePlan`. The cost is that a bad deployment can only be replaced, and subscribers must approve again.

## Merchant accounts and transfers

| Threat | Answer |
|---|---|
| Charging a wallet that did not agree, through the shared allowance | Only the proposed wallet can accept a transfer, and acceptance names the plan |
| A stolen owner key taking over subscriptions | Only the subscriber can propose a transfer |
| A stolen owner key redirecting revenue | Not prevented. It is visible through `PayoutChanged` and the `merchant.updated` webhook. A Safe as owner, with a separate payout address, limits the damage to future revenue |
| Control handed to a mistyped address | Ownership moves in two steps |
| A previous owner creating plans under the account | `createPlan` checks `ownerOf(account)` and nothing else |
| The merchant's share stuck in the manager | The payout cannot be the manager's own address |
| Unbacked credit through intro pricing | Credit comes from `billedPrice`, written on every billed cycle, and intro prices are below the full price |
| Intro prices forever through plan hopping | `changePlan` clears the intro cycles left before billing. Cancelling and subscribing again is allowed, as with trials; eligibility is checked off-chain |
| A completion undone, then charged again | Only `_collect` sets COMPLETED, `changePlan` sets ACTIVE only when the subscription did not complete, and `_collect` refuses a cycle past `maxCycles` |
| Retiring a plan to hurt its subscribers | Retiring affects only new subscriptions and plan changes into the plan |
| Buying a retired plan's terms from an existing subscriber | Plans opt in to transfers at creation |
| Phishing a wallet into accepting, or a subscriber into proposing | The portal shows the plan, price and merchant before an acceptance, and warns before a proposal that the subscription and its paid time leave the wallet |

`test/ManagerV2.t.sol` covers each guard, and the invariants `completedIsTerminal`, `cycleLimitHolds`, `retiredPlansGainNothing` and `subscriberChangesOnlyByAcceptance` fuzz them alongside `creditBacked` with intro plans and transfers in the handler.

## Dunning enforced on-chain

Without a rule, a stranger could call `charge()` repeatedly while a pull fails and push a subscription from ACTIVE to PAUSED in one block (finding H-1). The contract records a failure only when `retryGap(failedAttempts)` has passed since `lastFailedAt`: no wait before the first failure, then 1 day before the second, 3 before the third and 7 before every later one. A failing call sooner reverts `RetryTooSoon` and changes nothing. Successful charges are never held back, so a subscriber who tops up is charged at once, and resume clears the timer and the failure count.

The earliest auto-pause is `1 + 3 + 7 x (2 x maxFailed - 3)` days after the first failure, whoever calls: 1 day for `maxFailed` 1, 11 days for 2, 25 days for 3. `test/FailureCooldown.t.sol` includes a griefer calling every day, and `invariant_failuresSpaced` fuzzes it. See [Dunning and Failures](Dunning-and-Failures.md).

## Spam and cost to the keeper

`createPlan` requires a cycle of at least `MIN_CYCLE` (1 day); a 1-second plan once let a self-paying subscription cost the keeper gas every cycle. Anyone can still create a plan priced at one unit (0.000001 USDC; amounts are 6-decimal units, see the [Glossary](Glossary.md)) and subscribe to it: the fee rounds to zero, the pulls never fail, so it never auto-pauses and the keeper pays gas for one charge a day, with no bound on how many exist. Today's mitigation is monitoring (the keeper balance alert in `ops/monitoring.md`); a keeper admission policy is open.

## External dependencies

- **USDC blocklist.** If USDC blocklists an account's payout address or the FeeRouter, the outgoing transfer reverts and so does the whole charge; the subscriber is not charged and the keeper backs off. In v2 the account's owner fixes a blocked payout with `setPayout`, and charges succeed again; the first one collects one cycle, and if a whole cycle passed it starts a fresh one, so further missed cycles are lost. Since the FeeRouter is immutable in the manager, a blocked one would stop every charge that pulls USDC until a new deployment. A blocklisted subscriber just fails the pull and enters dunning.
- **Treasury.** The deploy script refuses a mainnet deployment unless the treasury is a contract (a 2-of-3 Safe is planned, signers not yet set), but the treasury can later move itself to any non-zero address, including a plain key: `proposeTreasury` from the current treasury, then `acceptTreasury` from the new one. The second step (added after finding L-3 of the 2026-10-24 review) means a mistyped address cannot take over the fees. If its keys are lost, `sweep()` still works but pays an address nobody controls, so verify every `TreasuryProposed` and `TreasuryUpdated` event. On testnet the treasury is a plain key.
- **Deploy checks.** USDC and Permit2 must have code and USDC must report 6 decimals; on mainnet only the canonical addresses pass. Both become immutable.
- **Permit2.** The signer is `msg.sender`, so a relayer cannot pick the plan (relaying was removed on 2026-09-25). Anyone who sees a signed permit can submit it to Permit2 first and use up its nonce. `subscribeWithPermit2` then still subscribes when the subscriber's Permit2 allowance already covers the first cycle (at the intro price, if the plan has one) and has not expired, and otherwise re-throws Permit2's error (fixed for finding L-2 of the 2026-10-24 review; before, it always reverted).
- **`ref`.** Public and chosen by whoever subscribes, so a claim and not proof. Merchants should issue unguessable refs and track subscriptions by `subId`.

## API and pages

- **Sign-in.** Sign-In with Ethereum, EOA wallets only. The server writes the whole message, bound to `LEVY_PUBLIC_ORIGIN` and the chain ID, with a random nonce. A challenge lasts 5 minutes and works once, even if the signature is wrong; at most 10,000 are pending. A session lasts 24 hours and only the SHA-256 of its token is stored. See [Authentication](Authentication.md).
- **Cookies.** The pages use an `HttpOnly`, `SameSite=Strict` cookie, `__Host-` prefixed and `Secure` over https. A cookie-authenticated write must carry an `Origin` equal to `LEVY_PUBLIC_ORIGIN` or it gets 403, which also stops sibling sites such as getlevy.xyz. Backends use bearer tokens.
- **Scoping.** Every data route returns only the signed-in address's data: someone else's subscription or webhook id returns 404, and an address parameter naming someone else returns 403. Merchant routes act for a merchant account the signed-in address owns now, by the keeper's mirror of `ownerOf`, so a previous owner loses the account's data and webhooks once the handover is indexed.
- **CSP.** The HTML pages send `script-src 'self'` (no inline scripts), `default-src 'none'`, `connect-src 'self'` and `frame-ancestors 'none'`, and load no third-party code. Static serving rejects paths outside `api/public`.
- **Rate limiting.** `POST /api/auth/challenge` is the one unauthenticated route that writes; the example nginx site limits it to 10 a minute per IP.

## Webhooks

- **URL guard.** https on port 443, no credentials, public addresses only: loopback, private, link-local, carrier-grade NAT, multicast and reserved IPv4 ranges are refused and IPv6 must be global unicast. The check runs at registration and again at connect time, so DNS rebinding does not help. Redirects are never followed, requests time out after 5 seconds, and a merchant may register 5 endpoints.
- **Signatures.** Ed25519 over `{timestamp}.{deliveryId}.{webhookId}.{event}.{body}`. Receivers should reject timestamps more than 5 minutes off, drop delivery ids they have seen, reject unknown event types and malformed delivery ids (event names contain dots, so signing the event closes a re-splitting attack, finding L-10), verify against their own webhook id, and check that `merchant` is their address. One key signs for every merchant, so the webhook id is what stops a delivery made for one merchant's endpoint being forwarded to another's (H-1, 2026-10-24 infrastructure review). Delivery ids carry a random prefix fixed per database, so a recreated database never repeats one (M-3). See [Webhooks](Webhooks.md).
- **Isolation.** Delivery has its own loop, so a hanging endpoint cannot stall charging. Failures are stored only as coarse reasons (`HTTP 500`, `timeout after 5s`, `connection failed`, `refused: ...`).

## Key handling

| Key | Where it lives | Rules |
|---|---|---|
| Keeper key | `LEVY_KEEPER_KEY` in the keeper's environment (untracked `ops/keeper.env`, given to the keeper alone) | pays gas only; fund minimally, rotate if exposed, alert below 1 USDC |
| Webhook signing key | `LEVY_WEBHOOK_KEY_PATH` file (created mode 0600, on a volume only the keeper mounts) or `LEVY_WEBHOOK_KEY` | keeper only; the keeper publishes the public half for the API to serve, and signs only delivery rows that carry its own MAC |
| Deployer key | `DEPLOYER_PRIVATE_KEY` for one forge run | `script/deploy-testnet.ps1` reads it without echo and clears it |
| User keys | the user's wallet | the API holds none; the pages never see them |

Docker images exclude `.env`, `*.pem` and `*.db`, and containers run as a non-root user that can write only `/data`. No key belongs in the repository or in chat.

## Error handling across layers

| Layer | Pattern |
|---|---|
| Contracts | Named custom errors. A failed pull (direct or Permit2) returns false, so `charge()` records `ChargeFailed` and succeeds. Reverts remain for preconditions, `RetryTooSoon`, a failed pull inside `subscribe` or `changePlan` (`PaymentFailed`) and failed outgoing transfers |
| Keeper | `ChargeFailed` is a normal outcome owned by dunning. Any other charge error re-reads the subscription and backs off 1 minute, 5 minutes, 15 minutes, 1 hour, then 6 hours (in memory). Each loop catches and logs, so charging and delivery never stop each other. RPC calls retry 4 times; missing env vars stop startup |
| API | A `bad(status, message)` helper throws and Fastify returns JSON: 400 bad input, 401 no session, 403 cross-origin write or foreign address, 404 not found or not yours, 503 signing key unavailable or too many pending sign-ins |
| Pages | Wallet errors become plain messages. A transaction whose receipt cannot be read is reported as unknown, with its hash, and never resent blindly |

## Review history

| Review | Result | Handling |
|---|---|---|
| Self-review and [fee-math audit](https://github.com/RunTimeAdmin/levy/blob/main/FEE_MATH_AUDIT.md) | unbacked proration credit, relayed Permit2 subscribe, resume billing paused cycles and keeping failures, a `uint8` overflow in the auto-pause threshold, no minimum cycle | fixed 2026-09-25 with regression tests and invariants |
| [External, 2026-09-25](https://github.com/RunTimeAdmin/levy/blob/main/docs/REVIEW_2026-09-25.md) | 0 critical, 1 high (H-1), 10 low, 9 info | H-1 fixed 2026-09-26; L-9 (session token in localStorage) fixed 2026-09-26 with an HttpOnly cookie, an Origin check and a CSP; L-10 (event not signed) fixed |
| [External, 2026-10-02](https://github.com/RunTimeAdmin/levy/blob/main/docs/REVIEW_2026-10-02.md) | 10 findings | fixed: on-chain schedule, canonical mainnet addresses, exact checkout amounts, pending-transaction recovery, chain recheck. Open: keeper policy for uneconomic plans, verified merchant identity on the checkout, Permit2 checkout path and runway check, dunning rebuild after database loss. One finding (soak not started) was a status item |
| [External, 2026-10-06](https://github.com/RunTimeAdmin/levy/blob/main/docs/REVIEW_2026-10-06.md), received 2026-10-07 | none needs a contract change | items 7 to 12 below confirmed and open; the rest raised again or not defects. Fixes land on `main` and deploy after the soak |
| [Review, 2026-10-24](https://github.com/RunTimeAdmin/levy/blob/main/docs/REVIEW_2026-10-24.md) | 0 critical, 0 high, 2 medium, 4 low, 5 info | fixed 2026-10-24 with regression tests and the invariant `noBackToBackCharges`: M-1 (a merchant could resume the subscriber's pause or an auto-pause), M-2 (missed cycles pulled back to back after a PAST_DUE recovery), L-2 (Permit2 front-run) and L-3 (single-step treasury move). Deployed 2026-10-24 for soak 2 |
| [External, 2026-10-27](https://github.com/RunTimeAdmin/levy/blob/main/docs/REVIEW_2026-10-27.md) | 0 critical, 0 high, 5 medium, 5 low | covers the soak 2 contracts at `941d5ed`, not manager v2. Fixed the same day: L-2 and L-5 (the actor-count script). Fixed on manager v2: M-1 to M-4 and L-3 (2026-10-27), L-1 and L-4 (2026-10-28). Open: M-5, the treasury handover |

Two earlier testnet deployments, one without the H-1 fix and one with only a flat 1-day gap, were superseded and never used for billing. The soak started on 2026-10-07 on the current deployment. For the test suites and invariants see [Testing](Testing.md).

## Open items

From `SECURITY_REVIEW.md` section 9, all before mainnet:

1. Self-funded spam subscriptions cost the keeper a charge a day each, unbounded. Failed charges are capped: past `LEVY_MAX_SPONSORED_FAILURES` (6) in a row the keeper retries only when the funds cover the charge.
2. CEI inverted; pause, resume and cancel unguarded (safe with USDC).
3. `changePlan`, resume, and (since the 2026-10-24 review) a charge after failures or after a whole skipped cycle forgive the overdue time; confirm this is intended.
4. Fixed 2026-10-24: a Permit2 nonce front-run made `subscribeWithPermit2` revert. It now subscribes on the existing Permit2 allowance when that covers one cycle and has not expired (L-2 in the 2026-10-24 review).
5. A USDC-blocklisted merchant makes its charges revert. Narrowed in manager v2: the account's owner sets a new payout address and charges resume, though cycles missed meanwhile, beyond the one the next charge collects, are lost.
6. Narrowed 2026-10-24: the treasury move is two-step (`proposeTreasury`, then `acceptTreasury` from the new address), so a mistyped address cannot take over the fees (L-3 in the 2026-10-24 review). A plain key that accepts can still become the treasury.
7. Checkout: a second pre-connected tab does not stop at a pending subscribe, and the pending record expires after a day.
8. Portal top-up can add rounds twice after an unreadable approval receipt.
9. Fixed 2026-10-28: keeper replay after a crash duplicated webhook deliveries and failure rows (2026-10-27 review L-1). Still open: failures are stamped with sync time, not block time.
10. Webhook retries end at about 19 hours 21 minutes, not 24 hours; the docs now say so.
11. Fixed 2026-10-28: the wallet checked the network at connect only. It now checks before every transaction and names the chain in the request (2026-10-27 review L-4).
12. `solc` is not pinned in `foundry.toml` (the deployment used 0.8.33), `foundry.lock` names a different OpenZeppelin commit from the submodule, and the source is not verified on the explorer.
13. A dunning row stays listed after pause or cancel until its stale retry time.
14. Fixed 2026-10-27: the API container held the keeper's gas key and could read the signing key. Both now stay with the keeper (2026-10-27 review M-1).
15. The CI ABI drift check ignores the `.bin` files used by the keeper integration test.
16. Fixed 2026-10-27: the keeper's database was not tied to a chain and manager (2026-10-27 review M-4).
17. Fixed 2026-10-27: `LEVY_DUNNING_DAYS` accepted gaps shorter than `retryGap` (2026-10-27 review L-3).

Also open: verified merchant identity on the checkout, a Permit2 checkout path and Permit2 in the runway check, treasury signers, contract-wallet sign-in, scoped API keys and the external audit.

## Reporting a vulnerability

Email **hello@getlevy.xyz** with "Security" in the subject: what is affected, steps to reproduce, the impact and any fix you know. Keep it private until it is fixed or a date is agreed, and do not open a public issue. In scope: the testnet contracts, the app, the keeper and getlevy.xyz. Out of scope: Arc, USDC, Permit2 and wallets, denial of service, social engineering and scanner output without impact. Test only with your own wallets, plans and subscriptions on testnet, with slow automated requests. Reports are acknowledged within 3 business days; there is no paid bug bounty yet. The full policy is `SECURITY.md` and https://getlevy.xyz/security.html.

## Source files

- [src/SubscriptionManager.sol](https://github.com/RunTimeAdmin/levy/blob/main/src/SubscriptionManager.sol)
- [src/FeeRouter.sol](https://github.com/RunTimeAdmin/levy/blob/main/src/FeeRouter.sol)
- [script/Deploy.s.sol](https://github.com/RunTimeAdmin/levy/blob/main/script/Deploy.s.sol)
- [test/FailureCooldown.t.sol](https://github.com/RunTimeAdmin/levy/blob/main/test/FailureCooldown.t.sol)
- [api/src/auth.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/auth.ts)
- [api/src/server.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/server.ts)
- [keeper/src/webhook-url.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhook-url.ts)
- [keeper/src/webhooks.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhooks.ts)
- [SECURITY_REVIEW.md](https://github.com/RunTimeAdmin/levy/blob/main/SECURITY_REVIEW.md)
- [SECURITY.md](https://github.com/RunTimeAdmin/levy/blob/main/SECURITY.md)

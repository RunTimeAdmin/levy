# Security

This page covers Levy's trust and threat model, the controls in the code, what the reviews found and what is still open. Levy runs on Arc testnet only, nothing is on mainnet, nothing has been externally audited and no real money flows through it. The contracts never hold funds at rest. Where `SECURITY_REVIEW.md`, `FEE_MATH_AUDIT.md` and the code disagree, the code wins.

## Trust model

- **Anyone** can call `charge()` and `sweep()`, create plans and subscribe as themselves. They cannot pull anything but a subscriber's pre-approved USDC, send it anywhere but the plan's merchant and the FeeRouter, charge early, record failures faster than `retryGap`, or subscribe someone else.
- **Merchants** control their own plans (immutable) and can pause or cancel subscriptions on them, and resume a pause they made themselves. They cannot change a price, pull more than it, or move a subscriber to another merchant's plan. A merchant cannot resume a pause its subscriber made or a dunning auto-pause (`NotSubscriber`), so a subscriber's pause holds until the subscriber resumes. Before the fix for finding M-1 of the 2026-10-24 review, a merchant could resume either.
- **Subscribers** can pause, resume (any pause), cancel, switch to another plan of the same merchant and revoke the allowance at any time. They are never charged more than the plan price per cycle, or more than the allowance.
- **The keeper operator** holds a gas key and the webhook signing key and runs the database. The contracts give the keeper no role: it cannot take user funds or alter plans, only fail to charge or misreport.
- **Arc, USDC and Permit2** are trusted external dependencies.

## Why a permissionless `charge()` is safe

`charge(subId)` loads the subscription and plan from storage, which the caller cannot influence. The amount due is the plan price minus credit, and credit only comes from cycles that were paid. The pull moves USDC from the subscriber to the manager, never to the caller, and the manager pays the plan's merchant (fixed per plan) and the FeeRouter (immutable) in the same transaction, so it keeps no balance (`invariant_managerHoldsNothing`). Before `nextChargeAt`, or on a paused or cancelled subscription, the call reverts `NotChargeable`. Front-running changes nothing. The one thing a caller controls is when a failing pull is recorded, which the contract spaces out (see Dunning).

## Reentrancy and checks-effects-interactions

`subscribe`, `subscribeWithPermit2`, `charge` and `changePlan` are `nonReentrant`, which covers every path that calls USDC or Permit2; outgoing transfers use SafeERC20. These paths write `nextChargeAt`, `failedAttempts`, `status` and `chargeCount` after the transfers, so they do not follow checks-effects-interactions. With standard USDC, which has no transfer callbacks, no reentrant path exists and the guard is defence in depth. Pause, resume and cancel are unguarded, so with a token that made callbacks a cancel issued inside `changePlan`'s transfer would be overwritten by `status = ACTIVE`. This is open for the auditor; reorder if the token ever changes.

## Access control

| Function | Who | Note |
|---|---|---|
| `createPlan` | anyone | the caller becomes the plan's merchant |
| `subscribe` | anyone, as themselves | `ref` is public and caller-chosen |
| `subscribeWithPermit2` | the permit signer only | spender and token checked before `permit()` |
| `charge` | anyone | see above |
| `pauseSubscription`, `cancelSubscription` | subscriber or the plan's merchant | a merchant pause sets `pausedByMerchant` |
| `resumeSubscription` | subscriber; the plan's merchant only for its own pause | resume is a fresh start |
| `changePlan` | subscriber only | same-merchant plans only |
| `FeeRouter.sweep` | anyone | destination fixed to `treasury` |
| `FeeRouter.proposeTreasury` | current treasury only | accepts any non-zero address; sets `pendingTreasury` |
| `FeeRouter.acceptTreasury` | the pending treasury only | completes the move |

The manager has no owner, admin function, pause switch or upgrade path. Plans are immutable, so there is no repricing attack after a subscriber approves; a new price means a new plan that the subscriber must choose with `changePlan`. The cost is that a bad deployment can only be replaced, and subscribers must approve again.

## Dunning enforced on-chain

Without a rule, a stranger could call `charge()` repeatedly while a pull fails and push a subscription from ACTIVE to PAUSED in one block (finding H-1). The contract records a failure only when `retryGap(failedAttempts)` has passed since `lastFailedAt`: no wait before the first failure, then 1 day before the second, 3 before the third and 7 before every later one. A failing call sooner reverts `RetryTooSoon` and changes nothing. Successful charges are never held back, so a subscriber who tops up is charged at once, and resume clears the timer and the failure count.

The earliest auto-pause is `1 + 3 + 7 x (2 x maxFailed - 3)` days after the first failure, whoever calls: 1 day for `maxFailed` 1, 11 days for 2, 25 days for 3. `test/FailureCooldown.t.sol` includes a griefer calling every day, and `invariant_failuresSpaced` fuzzes it. See [Dunning and Failures](Dunning-and-Failures.md).

## Spam and cost to the keeper

`createPlan` requires a cycle of at least `MIN_CYCLE` (1 day); a 1-second plan once let a self-paying subscription cost the keeper gas every cycle. Anyone can still create a plan priced at one unit (0.000001 USDC; amounts are 6-decimal units, see the [Glossary](Glossary.md)) and subscribe to it: the fee rounds to zero, the pulls never fail, so it never auto-pauses and the keeper pays gas for one charge a day, with no bound on how many exist. Today's mitigation is monitoring (the keeper balance alert in `ops/monitoring.md`); a keeper admission policy is open.

## External dependencies

- **USDC blocklist.** If USDC blocklists a plan's merchant or the FeeRouter, the outgoing transfer reverts and so does the whole charge; the subscriber is not charged and the keeper backs off. Only a new plan fixes a blocked merchant, and since the FeeRouter is immutable in the manager, a blocked one would stop every charge that pulls USDC until a new deployment. A blocklisted subscriber just fails the pull and enters dunning.
- **Treasury.** The deploy script refuses a mainnet deployment unless the treasury is a contract (a 2-of-3 Safe is planned, signers not yet set), but the treasury can later move itself to any non-zero address, including a plain key: `proposeTreasury` from the current treasury, then `acceptTreasury` from the new one. The second step (added after finding L-3 of the 2026-10-24 review) means a mistyped address cannot take over the fees. If its keys are lost, `sweep()` still works but pays an address nobody controls, so verify every `TreasuryProposed` and `TreasuryUpdated` event. On testnet the treasury is a plain key.
- **Deploy checks.** USDC and Permit2 must have code and USDC must report 6 decimals; on mainnet only the canonical addresses pass. Both become immutable.
- **Permit2.** The signer is `msg.sender`, so a relayer cannot pick the plan (relaying was removed on 2026-09-25). Anyone who sees a signed permit can submit it to Permit2 first and use up its nonce. `subscribeWithPermit2` then still subscribes when the subscriber's Permit2 allowance already covers one cycle and has not expired, and otherwise re-throws Permit2's error (fixed for finding L-2 of the 2026-10-24 review; before, it always reverted).
- **`ref`.** Public and chosen by whoever subscribes, so a claim and not proof. Merchants should issue unguessable refs and track subscriptions by `subId`.

## API and pages

- **Sign-in.** Sign-In with Ethereum, EOA wallets only. The server writes the whole message, bound to `LEVY_PUBLIC_ORIGIN` and the chain ID, with a random nonce. A challenge lasts 5 minutes and works once, even if the signature is wrong; at most 10,000 are pending. A session lasts 24 hours and only the SHA-256 of its token is stored. See [Authentication](Authentication.md).
- **Cookies.** The pages use an `HttpOnly`, `SameSite=Strict` cookie, `__Host-` prefixed and `Secure` over https. A cookie-authenticated write must carry an `Origin` equal to `LEVY_PUBLIC_ORIGIN` or it gets 403, which also stops sibling sites such as getlevy.xyz. Backends use bearer tokens.
- **Scoping.** Every data route returns only the signed-in address's data: someone else's subscription or webhook id returns 404, and an address parameter naming someone else returns 403.
- **CSP.** The HTML pages send `script-src 'self'` (no inline scripts), `default-src 'none'`, `connect-src 'self'` and `frame-ancestors 'none'`, and load no third-party code. Static serving rejects paths outside `api/public`.
- **Rate limiting.** `POST /api/auth/challenge` is the one unauthenticated route that writes; the example nginx site limits it to 10 a minute per IP.

## Webhooks

- **URL guard.** https on port 443, no credentials, public addresses only: loopback, private, link-local, carrier-grade NAT, multicast and reserved IPv4 ranges are refused and IPv6 must be global unicast. The check runs at registration and again at connect time, so DNS rebinding does not help. Redirects are never followed, requests time out after 5 seconds, and a merchant may register 5 endpoints.
- **Signatures.** Ed25519 over `{timestamp}.{deliveryId}.{webhookId}.{event}.{body}`. Receivers should reject timestamps more than 5 minutes off, drop delivery ids they have seen, reject unknown event types and malformed delivery ids (event names contain dots, so signing the event closes a re-splitting attack, finding L-10), verify against their own webhook id, and check that `merchant` is their address. One key signs for every merchant, so the webhook id is what stops a delivery made for one merchant's endpoint being forwarded to another's (H-1, 2026-10-24 infrastructure review). Delivery ids carry a random prefix fixed per database, so a recreated database never repeats one (M-3). See [Webhooks](Webhooks.md).
- **Isolation.** Delivery has its own loop, so a hanging endpoint cannot stall charging. Failures are stored only as coarse reasons (`HTTP 500`, `timeout after 5s`, `connection failed`, `refused: ...`).

## Key handling

| Key | Where it lives | Rules |
|---|---|---|
| Keeper key | `LEVY_KEEPER_KEY` in the keeper's environment (untracked `ops/.env`) | pays gas only; fund minimally, rotate if exposed, alert below 1 USDC |
| Webhook signing key | `LEVY_WEBHOOK_KEY_PATH` file (created mode 0600) or `LEVY_WEBHOOK_KEY` | shared by keeper and API; only the public half is published |
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
| [Review, 2026-10-24](https://github.com/RunTimeAdmin/levy/blob/main/docs/REVIEW_2026-10-24.md) | 0 critical, 0 high, 2 medium, 4 low, 5 info | fixed 2026-10-24 with regression tests and the invariant `noBackToBackCharges`: M-1 (a merchant could resume the subscriber's pause or an auto-pause), M-2 (missed cycles pulled back to back after a PAST_DUE recovery), L-2 (Permit2 front-run) and L-3 (single-step treasury move). Not yet deployed |

Two earlier testnet deployments, one without the H-1 fix and one with only a flat 1-day gap, were superseded and never used for billing. The soak started on 2026-10-07 on the current deployment. For the test suites and invariants see [Testing](Testing.md).

## Open items

From `SECURITY_REVIEW.md` section 9, all before mainnet:

1. Self-funded spam subscriptions cost the keeper a charge a day each, unbounded.
2. CEI inverted; pause, resume and cancel unguarded (safe with USDC).
3. `changePlan`, resume, and (since the 2026-10-24 review) a charge after failures or after a whole skipped cycle forgive the overdue time; confirm this is intended.
4. Fixed 2026-10-24: a Permit2 nonce front-run made `subscribeWithPermit2` revert. It now subscribes on the existing Permit2 allowance when that covers one cycle and has not expired (L-2 in the 2026-10-24 review).
5. A USDC-blocklisted merchant makes its charges revert.
6. Narrowed 2026-10-24: the treasury move is two-step (`proposeTreasury`, then `acceptTreasury` from the new address), so a mistyped address cannot take over the fees (L-3 in the 2026-10-24 review). A plain key that accepts can still become the treasury.
7. Checkout: a second pre-connected tab does not stop at a pending subscribe, and the pending record expires after a day.
8. Portal top-up can add rounds twice after an unreadable approval receipt.
9. Keeper replay after a crash can duplicate webhook deliveries and stamp failures with sync time.
10. Webhook retries end at about 19 hours 21 minutes, not 24 hours; the docs now say so.
11. The wallet checks the network at connect only.
12. `solc` is not pinned in `foundry.toml` (the deployment used 0.8.33), `foundry.lock` names a different OpenZeppelin commit from the submodule, and the source is not verified on the explorer.
13. A dunning row stays listed after pause or cancel until its stale retry time.
14. The Compose file gives the internet-facing API container the keeper's `.env`, including the keeper's gas key, which the API never reads.
15. The CI ABI drift check ignores the `.bin` files used by the keeper integration test.

Also open: verified merchant identity on the checkout, a Permit2 checkout path and Permit2 in the runway check, dunning rebuild after database loss, treasury signers, contract-wallet sign-in, scoped API keys and the external audit.

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

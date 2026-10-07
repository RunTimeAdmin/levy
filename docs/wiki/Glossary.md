# Glossary

The terms Levy's code, API and docs use, in alphabetical order, with where each appears. Amounts everywhere are integers in 6-decimal USDC units (see the first entry). For how the parts fit together see [Architecture](Architecture.md).

| Term | Meaning | Where it appears |
|---|---|---|
| 6-decimal units | USDC amounts as integers with six decimals, through the ERC-20 interface: 1 USDC = 1,000,000 units, so 10 USDC is `10000000`. Arc's native 18-decimal gas balance never enters payment logic | every `price`, `amount`, `fee` and `credit`; `formatUsdc` in `api/src/server.ts`; the decimals check in `script/Deploy.s.sol` |
| Advance billing | Each pull pays for the cycle that starts at it. With no trial the first cycle is pulled at subscribe (a failed pull reverts with `PaymentFailed`); a plan change bills the new plan at once | `_subscribe`, `_collect`, `changePlan` |
| Allowance | The USDC ERC-20 allowance a subscriber grants the SubscriptionManager: one pool shared by all of their Levy subscriptions, and the ceiling on what Levy can pull | `_tryPull`; the checkout approves `price x N` cycles (default 12) on top of the existing allowance |
| Allowance runway | How many rounds of charges the allowance covers: the allowance divided by the summed prices of the subscriber's chargeable subscriptions. Below 2 rounds it is flagged `low` and each affected subscription's merchant gets one `allowance.low` webhook. Only direct allowances count, so Permit2 subscribers read as low | `keeper/src/funds.ts`, `subscriber_funds` table, `GET /api/funds` |
| Arc | The L1 Levy runs on; USDC is its gas token. Chain ID 5042 (mainnet) and 5042002 (testnet), about 0.5 s blocks, single-block finality | `.env` files, `api/public/wallet.js`, `VERIFICATION.md` |
| Auto-pause | The contract moves a subscription to PAUSED and emits `AutoPaused` when `failedAttempts` reaches twice `maxFailed`. It happens inside `charge()`; the keeper never pauses anything | `_recordFailure` |
| Backoff | The keeper's delay before retrying a charge that failed for a non-payment reason (a revert or RPC error): 1 min, 5 min, 15 min, 1 h, then 6 h, in memory only. Not the dunning schedule | `ERROR_BACKOFF_SEC` in `keeper/src/keeper.ts` |
| Chain time | The timestamp of the latest block. The keeper uses it, not the wall clock, for due and dunning math | `Indexer.sync` (`nowSec`) |
| Charge | `charge(subId)`: pulls one cycle of a due subscription. Permissionless; the keeper is the usual caller. Each success is also a row in `charges` | `SubscriptionManager.charge`, `Keeper.tryCharge` |
| Credit (proration) | The balance in `Subscription.credit`. A plan change adds `oldPrice x remainingSeconds / oldCycleSeconds`, rounded down, for unused paid time. It is spent before any pull and is always backed by USDC the subscription paid. Trial time earns none | `changePlan`, `_collect`, `invariant_creditBacked` |
| Cycle | The billing period, `cycleSeconds`, from `MIN_CYCLE` (1 day) to `MAX_CYCLE` (10 years). The dashboard's "Monthly" is a fixed 30 days | `Plan.cycleSeconds` |
| Dead letter | A webhook delivery given up on: status `dead` once its next retry would pass 24 hours of age (last attempt about 19 h 21 min), or when its webhook is deleted or deactivated | `webhook_deliveries.status`, `nextRetryAt` in `keeper/src/webhooks.ts` |
| Delivery id | The `webhook_deliveries` row id, sent as `X-Levy-Delivery` and covered by the signature. It is the same across retries of one delivery, so receivers use it to drop duplicates | `signedContent`, `GET /api/deliveries` |
| Dunning | Handling of failed payments: an on-chain failure counter with spaced recording, an off-chain retry schedule, and webhooks | `_recordFailure`, `retryGap`, `keeper/src/dunning.ts`, `dunning` table, `GET /api/dunning` |
| FEE_BPS | The constant `100`. Despite the name it is a divisor: `fee = amount / 100`, which is 1% rounded down; the merchant keeps the remainder | `_collect`, `FEE_MATH_AUDIT.md` |
| FeeRouter | The contract that receives the 1% fee and holds it until `sweep()` | `src/FeeRouter.sol` |
| graceSeconds | A plan field stored on-chain and read by nothing: not the contract, the keeper or the API. The pages send 0 | `createPlan`, the `Plan` struct |
| Invoice | A `Charged` event recorded as a `charges` row: invoiceRef, subscription, amount, fee, transaction hash, block, charge count. Exported as CSV and announced by `invoice.ready` | `GET /api/invoices` |
| invoiceRef | The `bytes32` in `Charged`: `keccak256(abi.encode(subId, chargeCount))`. Deterministic and moves no funds | `_collect` |
| Keeper | The off-chain service in `keeper/`: indexes events, calls `charge()`, retries failures, checks allowance runway and delivers webhooks. It pays gas from its own key; run one instance | `keeper/src/index.ts` |
| Lookback | `LEVY_LOOKBACK_BLOCKS`, default 5000 (about 40 minutes): how far back the first sync scans when no cursor exists. Raise it to reach the deploy block | `keeper/src/config.ts` |
| maxFailed | Plan field (`uint8`, 1 to 255): the number of failures before PAST_DUE. Auto-pause comes at twice that | `createPlan`, `_recordFailure` |
| MIN_CYCLE | The constant 1 day, the shortest `cycleSeconds`. It bounds how often the keeper pays gas for one subscription | `createPlan` |
| nextChargeAt | The `uint64` time when the next cycle may be charged. A successful charge adds exactly one cycle to the stored value; `changePlan` sets it to now plus the new cycle; resume moves a passed date to now | the `Subscription` struct |
| PAST_DUE | Status 2, set when `failedAttempts` reaches `maxFailed`. Still chargeable; a successful charge clears it | `_recordFailure` |
| Permit2 | Uniswap's allowance contract at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. A subscriber signs a `PermitSingle` naming the manager as spender and submits it through `subscribeWithPermit2`; the manager also falls back to Permit2 when the direct pull fails. Needs a one-time USDC approval to Permit2 | `src/IPermit2.sol`, `_tryPull`, `keeper/scripts/permit2-subscribe.mjs` |
| Plan | An immutable on-chain offer: merchant, price, `cycleSeconds`, `trialSeconds`, `graceSeconds`, `maxFailed`. It has no name on-chain, and a new price means a new plan | `createPlan`, `plans` table |
| ref | The merchant's own `bytes32` reference for a subscription: set at subscribe, stored in `subscriptionRef`, emitted in `Subscribed` and carried on every webhook. Public and chosen by whoever subscribes, so a claim, not proof. Checkout links take up to 31 ASCII characters or `0x` plus 64 hex digits | `subscribe`, `?ref=` on `checkout.html` |
| retryGap | View `retryGap(failures)`: the shortest time between recorded failures, 0 before the first, then 1 day, 3 days and 7 days. The on-chain form of the dunning schedule | `SubscriptionManager.retryGap` |
| RetryTooSoon | The error from a failing `charge()` made before `lastFailedAt + retryGap`. It changes nothing, so strangers cannot speed up auto-pause. The keeper treats it as a non-payment error and backs off | `_recordFailure` |
| SIWE | Sign-In with Ethereum (EIP-4361). The server writes a message bound to `LEVY_PUBLIC_ORIGIN` and the chain, the wallet signs it, and a 24-hour session follows (cookie for the pages, bearer token for backends). EOA wallets only | `api/src/auth.ts`, `/api/auth/*` |
| Soak | The M4 testnet run: at least a week of real billing on the 2026-10-03 deployment, day 0 on 2026-10-07. Checklist and log in `ops/testnet-soak.md` | `ops/testnet-soak.md` |
| Soak wallets S1 to S5 | Test wallets for the soak: S1 the control, left alone; S2 trial, pause, resume, cancel; S3 a failing allowance (dunning, PAST_DUE, auto-pause, recovery); S4 plan changes; S5 Permit2 subscribe. A separate merchant wallet creates the plans | `ops/testnet-soak.md` |
| Status | The subscription state, stored as a number: TRIAL 0, ACTIVE 1, PAST_DUE 2, PAUSED 3, CANCELLED 4. Cancelled is final | `enum Status`, `subscriptions.status`, API `statusName` |
| Subscription | A subscriber's link to a plan: subscriber, planId, start, `nextChargeAt`, `failedAttempts`, credit, `chargeCount`, status | the `Subscription` struct, `subscriptions` table |
| Sweep | `FeeRouter.sweep()` sends the router's whole USDC balance to the treasury. Anyone may call it; the destination is fixed | `FeeRouter.sweep`, event `Swept` |
| Treasury | The address that receives swept fees and the only one that can call `setTreasury`. Mainnet requires a contract (a 2-of-3 Safe is planned); on testnet it is the deployer's key | `FeeRouter.treasury`, `ops/treasury-multisig.md` |
| Trial | `trialSeconds`, shorter than the cycle: no charge at subscribe, status TRIAL, first charge at start plus trial. Trial time earns no credit | `_subscribe` |
| USDC | The stablecoin that is also Arc's gas token. Levy uses its ERC-20 face at `0x3600000000000000000000000000000000000000`, which has 6 decimals | `LEVY_USDC_ADDRESS`, `script/Deploy.s.sol` |
| Webhook | A signed HTTPS POST from the keeper to a merchant endpoint, one of ten event types, with `X-Levy-Signature`, `X-Levy-Timestamp`, `X-Levy-Delivery`, `X-Levy-Key-Id` and `X-Levy-Event` headers (Ed25519 over `{timestamp}.{deliveryId}.{event}.{body}`) | `keeper/src/webhooks.ts`, `webhooks` table |

## Source files

- [src/SubscriptionManager.sol](https://github.com/RunTimeAdmin/levy/blob/main/src/SubscriptionManager.sol)
- [src/FeeRouter.sol](https://github.com/RunTimeAdmin/levy/blob/main/src/FeeRouter.sol)
- [src/IPermit2.sol](https://github.com/RunTimeAdmin/levy/blob/main/src/IPermit2.sol)
- [keeper/src/keeper.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/keeper.ts)
- [keeper/src/funds.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/funds.ts)
- [keeper/src/webhooks.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/webhooks.ts)
- [keeper/src/db.ts](https://github.com/RunTimeAdmin/levy/blob/main/keeper/src/db.ts)
- [api/src/auth.ts](https://github.com/RunTimeAdmin/levy/blob/main/api/src/auth.ts)
- [ops/testnet-soak.md](https://github.com/RunTimeAdmin/levy/blob/main/ops/testnet-soak.md)
- [FEE_MATH_AUDIT.md](https://github.com/RunTimeAdmin/levy/blob/main/FEE_MATH_AUDIT.md)

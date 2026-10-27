# Arc testnet soak 2 (M4)

A week of real billing on Arc testnet against the contracts with the fixes
from the 2026-10-24 review, before an audit and mainnet. Soak 1
(`ops/testnet-soak-1.md`) ran from 2026-10-07 to 2026-10-24 against the
previous deployment. Everything in it that ran behaved as designed, but a
subscriber's own pause and cancel, both plan changes, the planned keeper
restart, the sweep and the CSV check never happened. They run here, together
with live checks of the fixes: a merchant cannot resume a subscriber's pause
(M-1), a recovery after failed charges pulls one cycle and no more (M-2), and
the treasury moves only in two steps (L-3).

**Deployment under test** (see README, Deployments):

| | |
|---|---|
| SubscriptionManager | `0xea24ac9c1217a671139d93225fdcf19ea3c4df4e` |
| FeeRouter | `0x9e62309243da8be600a718a323fbbdfce00f3ce8` |
| Deploy blocks | 68869601 (FeeRouter), 68869602 (SubscriptionManager), 2026-10-24 |
| Treasury (= deployer) | `0xe305652DB35Ed45A567538438c9B29ede7097162` |
| Keeper | `0x712422F5fBE3935612AaCAdC5651443356e6c2B4` |
| Code | contracts built from `54724d0` (bytecode matches); keeper and API from the commit in the host's `REVISION` file |
| Dashboard, portal, checkout | https://app.getlevy.xyz |
| Host | srv1296980, compose project `levy` in `/docker/levy` |

**Who does what.** David holds every private key and signs every transaction
by hand, either in a browser wallet or with `cast --interactive`, which prompts
for the key without echoing it. The one standing exception is the keeper's key,
which he set on the host with `ops/set-keeper-key.sh` (it lives in the
untracked `ops/.env`) and which signs the charge transactions. Claude runs the
server side: the keeper, the daily checks, the receiver for webhooks, and the
log at the bottom of this file. No private key is ever pasted into chat or
committed to the repo.

All times are UTC. "Day N" means N x 24 hours after that subscription started.

**Lesson from soak 1.** The wallet only offers the accounts the site is
connected to, and the portal keeps its own session. Before every action, sign
out, connect the wallet you mean to use, and read the address in the header.

## Wallets

The soak 1 wallets are reused; each holds plenty of testnet USDC (27 to 113 on
2026-10-24). Their allowances to the old manager do not carry over, so every
subscription starts from a zero allowance. One new wallet is needed on day 7.

| Role | Address | Used for |
|---|---|---|
| Merchant | `0x83F45b842c15c1417fDbCE296D966b1CE17544bD` | creates the plans, receives 99%, signs in to the dashboard |
| S1 | `0x66270a1d8E1B1fD41F4E46D41F807c61948E6072` | the control: one plan, left alone all week |
| S2 | `0xE4E3eE5d4aE63b9894A42AB102F04395ee5F56A2` | trial; its own pause (which the merchant cannot resume) and resume; a merchant pause and resume; its own cancel |
| S3 | `0x451567A35648445143768d3D6e9072A50BB2d85F` | a failing allowance: dunning, past due, then a top-up that must pull exactly one cycle |
| S4 | `0x86c7263971132907Ad11f3904fB21Ad819aF0949` | plan changes: an upgrade, then a downgrade |
| S5 | `0x31C4792Efd52943BDA3CAfa2eD12822f526266B5` | Permit2 subscribe |
| T2 | create on day 7 with `cast wallet new`, fund 1 USDC | the second treasury, for the two-step move |

## Setup (day 0)

### 1. Host (Claude)

- [x] Old source tree and database set aside on the host (`/root/levy-src-08991fa`, `/root/levy-db-pre-d2b5455`), keeper and API rebuilt from `d2b5455` with the new `LEVY_MANAGER_ADDRESS`, a fresh database and the same webhook signing key (keyId `27628a5331108c43`)
- [x] `https://app.getlevy.xyz/api/config` shows the new manager; the keeper log shows it and the keeper address above
- [x] Receiver for webhooks still running at `https://app.getlevy.xyz/soak-hooks`; its log restarts at `/docker/levy/ops/soak/data/hooks.jsonl` (the soak 1 log is kept beside it as `hooks-soak1.jsonl`)
- [x] Fixes from the 2026-10-24 infrastructure review deployed (`docs/REVIEW_INFRA_2026-10-24.md`): webhooks signed for their destination webhook id with new-style delivery ids, the webhook cap enforced under concurrency, the receiver verifying against webhook id 1 and the soak merchant, `/soak-hooks` rate limited in nginx

### 2. Dashboard and webhooks (you)

The fresh database has no webhook registrations and no sessions.

- [x] At https://app.getlevy.xyz, sign in with the merchant wallet
- [x] Under Webhooks, add `https://app.getlevy.xyz/soak-hooks` with all ten events ticked
- [x] The Webhooks table shows it with ID **1**. The receiver verifies every signature against that id, so if it shows another number, tell Claude before going on

### 3. Plans (you, from the merchant wallet)

Either create each plan in the table below with **New plan** in the
dashboard (cycle and trial in days; plan 3 is a custom 2-day cycle with a
1-day trial), or use `cast`: in PowerShell, set the three variables once, then
run each `createPlan` line. Each one asks for the **merchant's** private key,
hidden, then sends the transaction.

```powershell
$cast = 'Z:\Sentinal Engine\foundry-bin\cast.exe'
$mgr  = '0xea24ac9c1217a671139d93225fdcf19ea3c4df4e'
$rpc  = 'https://rpc.testnet.arc.io'
```

Arguments are `price` (1 USDC = 1000000), `cycleSeconds`, `trialSeconds`,
`graceSeconds` (unused, 0) and `maxFailed`:

```powershell
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 1000000 86400 0 0 2 --rpc-url $rpc --interactive
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 2000000 86400 0 0 2 --rpc-url $rpc --interactive
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 1000000 172800 86400 0 2 --rpc-url $rpc --interactive
```

| Plan | Price | Cycle | Trial | Past due after | Auto-pause after | Used by |
|---|---|---|---|---|---|---|
| 1 | 1 USDC | 1 day | none | 2 failures | 4 failures | S1, S3, S4 (start), S5 |
| 2 | 2 USDC | 1 day | none | 2 failures | 4 failures | S4 (after the upgrade) |
| 3 | 1 USDC | 2 days | 1 day | 2 failures | 4 failures | S2 |

- [x] `& $cast call $mgr "planCount()(uint256)" --rpc-url $rpc` prints `3`
- [x] https://app.getlevy.xyz/api/plans lists all three with the merchant's address

### 4. Subscriptions (you, in the browser wallet)

Open each checkout link while the named wallet is the active account, connect,
set the number of cycles, then "Approve and subscribe" (two confirmations).

| Wallet | Link | Cycles to approve | Expect right after |
|---|---|---|---|
| S1 | https://app.getlevy.xyz/checkout.html?plan=1&ref=soak2-s1 | 12 | ACTIVE, charged 1 USDC |
| S2 | https://app.getlevy.xyz/checkout.html?plan=3&ref=soak2-s2 | 12 | TRIAL, not charged |
| S3 | https://app.getlevy.xyz/checkout.html?plan=1&ref=soak2-s3 | **2** | ACTIVE, charged 1 USDC, `allowance.low` (one round left) |
| S4 | https://app.getlevy.xyz/checkout.html?plan=1&ref=soak2-s4 | 12 | ACTIVE, charged 1 USDC |

The references are readable on purpose for the soak. Real merchants should use
unguessable ones (docs/merchant-guide.md).

- [x] (you) S5 subscribes to plan 1 with Permit2, from the repo on your PC. This exercises the new `subscribeWithPermit2`:

  ```powershell
  cd D:\REPO\levy
  node keeper\scripts\permit2-subscribe.mjs --plan 1 --ref soak2-s5
  ```

  It asks for **S5's** private key (hidden), shows the plan, the wallet and the transactions, and sends nothing until you type `yes`. Expect ACTIVE, charged 1 USDC, and an `allowance.low` straight away (the keeper still does not read Permit2 allowances, a known gap).
- [x] The dashboard shows five subscriptions with references soak2-s1 to soak2-s5
- [x] Record the subscription IDs:

| Wallet | Subscription ID | Subscribed at (UTC) |
|---|---|---|
| S1 | 1 (subscriber is the Merchant wallet, kept as the control, see the log) | 2026-10-26 17:43:53 |
| S2 | 2 | 2026-10-26 17:45:05 |
| S3 | 3 | 2026-10-26 17:46:14 |
| S4 | 4 | 2026-10-26 17:47:49 |
| S5 | 5 | 2026-10-26 17:49:23 |

## Scheduled actions

`<id>` is the wallet's subscription ID from the table above.

| When | Who | Action | Expect |
|---|---|---|---|
| Day 0 | you | `& $cast call $mgr "charge(uint256)" <S1 id> --rpc-url $rpc` | Reverts `NotChargeable` (not due yet): nobody can charge early |
| Day 1 | keeper | S2's trial ends | S2 charged 1 USDC, TRIAL to ACTIVE |
| Day 1 | keeper | S3's second charge | Succeeds; S3's allowance is now 0 |
| Day 2 | keeper | S3's third charge | Fails: `charge.failed`, `dunning.started`; still ACTIVE (plan 1 goes past due at 2 failures) |
| Day 2 | you | Right after that failure: `& $cast call $mgr "charge(uint256)" <S3 id> --rpc-url $rpc` | Reverts `RetryTooSoon` |
| Day 2 | you | Portal as S2: **Pause** | PAUSED; no charge while paused |
| Day 2 | you | Dashboard as the merchant: look at S2's row, then `& $cast call $mgr "resumeSubscription(uint256)" <S2 id> --from 0x83F45b842c15c1417fDbCE296D966b1CE17544bD --rpc-url $rpc` | **M-1.** The row shows "customer resumes" and no Resume button; the call reverts `NotSubscriber`. No key needed: `cast call` only simulates |
| Day 2.5 | you | S4 upgrades: portal as S4, **Change plan** to plan 2 (check the quoted price), or `& $cast send $mgr "changePlan(uint256,uint256)" <S4 id> 2 --rpc-url $rpc --interactive` (S4's key) | About half a day of plan 1 left becomes about 0.5 USDC of credit, about 1.5 USDC pulled, next charge in 1 day, `subscription.updated` |
| Day 3 | keeper | S3 retry | Fails again: PAST_DUE |
| Day 3 | (none) | S2's billing date passes while paused | No charge |
| Day 4 | you | Portal as S2: **Resume** | Fresh start: the keeper charges it within about 30 seconds, next charge 2 days later |
| Day 4 | Claude | `docker restart levy-keeper` just before a due charge | Charge collected once, no double charge, sync resumes. Then check `hooks.jsonl` for one event delivered twice under different delivery ids (`SECURITY_REVIEW.md` open item 9) |
| Day 4.75 | you | S4 downgrades, six hours after plan 2's day-4.5 charge: portal as S4, **Change plan** to plan 1, or `& $cast send $mgr "changePlan(uint256,uint256)" <S4 id> 1 --rpc-url $rpc --interactive` | 0.75 of a day of plan 2 left becomes 1.5 USDC of credit. Plan 1's first cycle is paid from it (a charge of 0 USDC); the 0.5 left carries, so the next charge a day later pulls only 0.5 USDC |
| Day 5 | you | Dashboard as the merchant: **Pause** S2, then **Resume** it | The row offers Resume for the merchant's own pause, and resuming works; nothing is charged (S2 is inside a paid cycle), next charge unchanged |
| Day 6 | keeper | S3 retry | Fails a third time; next retry on day 13, so S3 is not auto-paused within the soak |
| Day 7 | you | Portal as S3: **Top up** 3 rounds. Then from any funded wallet: `& $cast send $mgr "charge(uint256)" <S3 id> --rpc-url $rpc --interactive`, and right after it `& $cast call $mgr "charge(uint256)" <S3 id> --rpc-url $rpc` | **M-2.** Exactly one charge of 1 USDC, then the call reverts `NotChargeable`. S3 is ACTIVE with 0 failed attempts, and its next charge is one day after the payment. The old contract would have pulled about 6 USDC here, one per missed day |
| Day 7 | you | Portal as S2: **Cancel** | CANCELLED; nothing charged after this |
| Day 7 | you | Treasury move, below | Both steps needed; the fees reach T2 |
| Day 7 | you | Dashboard: Export CSV | One row per charge; totals match the chain |
| Day 8 | keeper | S3's first charge after the recovery | Collected one day after the day-7 payment, on time |

S1 and S5 are never touched: they should be charged exactly once a day, all
week.

### Treasury move (day 7, L-3)

Create T2 with `cast wallet new`, fund it with 1 USDC at
https://faucet.circle.com (it only pays gas), and note its address in the
Wallets table. Then:

```powershell
$router = '0x9e62309243da8be600a718a323fbbdfce00f3ce8'
& $cast send $router "proposeTreasury(address)" <T2> --rpc-url $rpc --interactive       # the deployer's key
& $cast call $router "treasury()(address)" --rpc-url $rpc                                # still the deployer
& $cast call $router "pendingTreasury()(address)" --rpc-url $rpc                         # T2
& $cast call $router "acceptTreasury()" --from 0x83F45b842c15c1417fDbCE296D966b1CE17544bD --rpc-url $rpc   # reverts OnlyPendingTreasury
& $cast send $router "acceptTreasury()" --rpc-url $rpc --interactive                     # T2's key
& $cast call $router "treasury()(address)" --rpc-url $rpc                                # T2
& $cast send $router "sweep()" --rpc-url $rpc --interactive                              # the merchant's key, so T2 pays no gas here
```

Expect `TreasuryProposed`, then `TreasuryUpdated`, `pendingTreasury()` back to
zero, and T2's USDC rising by exactly the fees recorded.

## Daily checks (Claude)

One status run a day, pasted into the log below:

- [ ] Keeper up, synced to within a minute of the chain head, no unhandled errors (rate-limit retries noted separately)
- [ ] Every charge that fell due was collected within 5 minutes of its billing date
- [ ] Per subscription: charge count and status match the schedule above
- [ ] USDC: merchant received 99%, fee router 1% (rounded down), per charge
- [ ] Webhooks: deliveries sent, failed, dead; every signature valid
- [ ] Keeper gas: USDC spent in the last 24 hours and balance left
- [ ] API health, certificate, disk

Nearly all of it comes from one command on the soak host (`ssh packrai-vps` from
David's PC):

```bash
bash /docker/levy/ops/soak-status.sh
```

Its output is described in `ops/testnet-soak-1.md`. As in soak 1, its "charge
transactions that errored" count includes recorded payment failures, so S3's
scheduled failures on days 2, 3 and 6 raise it.

## After the soak

Remove the soak-only pieces from the host:

- `docker compose -f /docker/levy/ops/soak/docker-compose.yml down`
- the `location ^~ /soak-hooks` block in `/etc/nginx/sites-available/app.getlevy.xyz`, then `nginx -t && systemctl reload nginx`
- the merchant's webhook endpoint for `/soak-hooks`, in the dashboard

## Stop the soak and investigate if

- any subscription is charged twice for one billing date, charged before it is due, or charged while paused or cancelled
- a charge after failures pulls more than one cycle, or leaves the subscription chargeable
- a merchant resumes a pause it did not make
- USDC goes anywhere other than the plan's merchant and the fee router (and, at the sweep, the treasury of record)
- the keeper is down or more than 10 minutes behind the chain for over an hour
- a webhook signature fails to verify

## Pass criteria

- [ ] 7 days with the keeper running (restarts allowed; no manual edits to its database)
- [ ] Every due charge collected once, within 5 minutes, all week
- [ ] Trial, dunning to past due, a subscriber's pause and resume, a merchant's pause and resume, a subscriber's cancel, upgrade and downgrade with credit, and Permit2 each behaved as expected above
- [ ] M-1: the merchant could not resume S2's own pause, on the dashboard or on-chain
- [ ] M-2: S3's recovery pulled exactly one cycle, and the next charge came one day after it
- [ ] L-3: the treasury moved only after T2 accepted, and the sweep paid T2 exactly the fees collected
- [ ] All ten event types received at least once, every signature valid, nothing dead-lettered
- [ ] On-chain totals, the database's invoices and the CSV agree to the unit
- [ ] Keeper gas about 0.002 to 0.003 USDC per charge, as the whitepaper states

When every box is ticked, the soak item under "Before mainnet" in the README is done.

## Log

| Date (UTC) | Who | What happened |
|---|---|---|
| 2026-10-24 | Claude | Host repointed at 13:57 UTC. Keeper and API rebuilt from `d2b5455` on the new SubscriptionManager `0xea24...df4e` with a fresh database (soak 1's kept in `/root/levy-db-pre-d2b5455`, its source tree in `/root/levy-src-08991fa`) and the unchanged webhook signing key; the receiver's soak 1 log is now `hooks-soak1.jsonl`. The first upload came from `git archive` with Windows line endings, which broke the shell scripts, so the tree was uploaded again with `core.autocrlf=false` and rebuilt. Status run: keeper 35 blocks behind, 0 plans and subscriptions, no webhook endpoints yet, keeper wallet 19.807 USDC, alerts none. Next: day 0, David. |
| 2026-10-24 | Claude | Fixes from the infrastructure review (`docs/REVIEW_INFRA_2026-10-24.md`: H-1, M-1, M-3, M-4, and PR #5 merged) deployed at 15:40 UTC, revision `7aad40e`, before day 0. Webhooks are now signed over the destination webhook id and carry `{16 hex digits}-{row id}` delivery ids; the receiver verifies against webhook id 1 and the soak merchant and keeps bodies only for valid signatures; `/soak-hooks` is rate limited in nginx (60 a minute, burst 30; the old site file is in `/root/app.getlevy.xyz.nginx.bak-20261024154033`). Status run clean: keeper 51 blocks behind, the same signing key, no alerts. |
| 2026-10-26 | Claude | Day 0, done by David between 17:43 and 17:50 UTC. Webhook endpoint 1 belongs to the merchant and has all ten events. Plans 1 to 3 match the table. Subscriptions: #1 on plan 1 at 17:43:53 with ref soak2-s1, but its subscriber is the Merchant wallet, not S1, because the merchant was still connected at checkout (S1 has no allowance and no subscription). S2 is #2 on plan 3 (TRIAL), S3 is #3 (1 USDC of allowance left), S4 is #4, and S5 is #5 by Permit2. Simulated `charge(1)` and `charge(4)` both revert `NotChargeable`. Status run at 17:50 UTC clean: 4 charges, 4 USDC pulled, the fee router holds 0.04 USDC and that equals the fees recorded, 15 webhooks delivered and verified with none invalid, keeper 7 blocks behind, no alerts. |
| 2026-10-26 | Claude | David kept #1 as the S1 control rather than replacing it. Its subscriber is the Merchant wallet, so each of its charges takes 1 USDC from the merchant and returns 0.99, and the merchant ends each day 0.01 USDC down on it. S1's wallet is not used in soak 2. The daily check was rewritten for soak 2 (subscriptions 1 to 5 on the new manager) and turned back on. |
| 2026-10-27 | Claude | Daily check: run at 13:13 UTC, before the day-1 charges (due 17:43 to 17:49). 4 charges so far, all on time. S1 (#1) ACTIVE 1 charge, S2 TRIAL 0 charges (trial ends 17:45), S3 ACTIVE 1 charge 0 fails, S4 ACTIVE plan 1 1 charge, S5 ACTIVE 1 charge; #6 empty. Fee router holds 0.04 USDC, equal to fees recorded, fee rule broken 0 times. 15 webhook deliveries sent, none failed, 0 invalid requests, 0 redelivered. Keeper 14 blocks behind with 19.81 USDC, containers up, no alerts. |

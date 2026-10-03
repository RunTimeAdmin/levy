# Arc testnet soak (M4)

A week of real billing on Arc testnet before an audit and mainnet. Every path
a merchant or customer can take runs at least once against the live
contracts, the keeper and the API, and the results are written down below.

**Deployment under test** (see README, Deployments):

| | |
|---|---|
| SubscriptionManager | `0x33c8e7e46583bdfd2e001f55ac1c58bd84eb739f` |
| FeeRouter | `0xa6efee5f5a2eb2afae102f790b4889fcc01fe848` |
| Treasury (= deployer) | `0xe305652DB35Ed45A567538438c9B29ede7097162` |
| Keeper | `0x712422F5fBE3935612AaCAdC5651443356e6c2B4` |
| Dashboard, portal, checkout | https://app.getlevy.xyz |
| Host | srv1296980, compose project `levy` in `/docker/levy` |

**Who does what.** David holds every private key and signs every transaction,
either in a browser wallet or with `cast --interactive`, which prompts for the
key without echoing it. Claude runs the server side: the keeper, the daily
checks, the receiver for webhooks, and the log at the bottom of this file. No
private key is ever pasted into chat or written to a file in the repo.

All times are UTC. "Day N" means N x 24 hours after that subscription started.

## Wallets

Create each with `cast wallet new` (or as a new account in your browser
wallet), fund it at https://faucet.circle.com (network: Arc Testnet), and
record only the **address** here.

| Role | Address | Funded | Used for |
|---|---|---|---|
| Merchant | | [ ] | creates the plans, receives 99%, signs in to the dashboard |
| S1 | | [ ] | the control: one plan, left alone all week |
| S2 | | [ ] | trial, pause, resume, cancel |
| S3 | | [ ] | a failing allowance: dunning, past due, auto-pause, recovery |
| S4 | | [ ] | plan changes: an upgrade, then a downgrade |
| S5 | | [ ] | Permit2 subscribe |

The merchant and S1 to S4 need to be accounts in your browser wallet, because
the dashboard, checkout and portal sign in with it. The checkout adds Arc
Testnet to the wallet if it is missing (chain 5042002, RPC
`https://rpc.testnet.arc.io`, currency USDC).

## Setup (day 0)

### 1. Plans (you, from the merchant wallet)

Either sign in to the dashboard as the merchant and create each plan in the
table below with **New plan** (cycle and trial in days; plan 3 is a custom
2-day cycle with a 1-day trial), or use `cast`: in PowerShell, set the three
variables once, then run each `createPlan` line. Each one asks for the
**merchant's** private key, hidden, then sends the transaction.

```powershell
$cast = 'Z:\Sentinal Engine\foundry-bin\cast.exe'
$mgr  = '0x33c8e7e46583bdfd2e001f55ac1c58bd84eb739f'
$rpc  = 'https://rpc.testnet.arc.io'
```

Arguments are `price` (1 USDC = 1000000), `cycleSeconds`, `trialSeconds`,
`graceSeconds` (unused, 0) and `maxFailed`:

```powershell
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 1000000 86400 0 0 2 --rpc-url $rpc --interactive
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 2000000 86400 0 0 2 --rpc-url $rpc --interactive
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 1000000 172800 86400 0 2 --rpc-url $rpc --interactive
& $cast send $mgr "createPlan(uint256,uint256,uint256,uint256,uint8)" 1000000 86400 0 0 1 --rpc-url $rpc --interactive
```

| Plan | Price | Cycle | Trial | Past due after | Auto-pause after | Used by |
|---|---|---|---|---|---|---|
| 1 | 1 USDC | 1 day | none | 2 failures | 4 failures | S1, S4 (start), S5 |
| 2 | 2 USDC | 1 day | none | 2 failures | 4 failures | S4 (after the upgrade) |
| 3 | 1 USDC | 2 days | 1 day | 2 failures | 4 failures | S2 |
| 4 | 1 USDC | 1 day | none | 1 failure | 2 failures | S3 |

- [ ] `& $cast call $mgr "planCount()(uint256)" --rpc-url $rpc` prints `4`
- [ ] https://app.getlevy.xyz/api/plans lists all four with the merchant's address

### 2. Dashboard and webhooks

- [x] (Claude) Receiver for webhooks running at `https://app.getlevy.xyz/soak-hooks` since 2026-09-26 (`ops/soak/webhook-receiver.mjs`, container `levy-soak-hooks`). It checks every delivery as docs/merchant-guide.md describes and logs one line per delivery to `/docker/levy/ops/soak/data/hooks.jsonl`.
- [ ] (you) At https://app.getlevy.xyz, sign in with the merchant wallet
- [ ] (you) Under Webhooks, add `https://app.getlevy.xyz/soak-hooks` with all ten events ticked

### 3. Subscriptions (you, in the browser wallet)

Open each checkout link while the named wallet is the active account, connect,
set the number of cycles, then "Approve and subscribe" (two confirmations).

| Wallet | Link | Cycles to approve | Expect right after |
|---|---|---|---|
| S1 | https://app.getlevy.xyz/checkout.html?plan=1&ref=soak-s1 | 12 | ACTIVE, charged 1 USDC |
| S2 | https://app.getlevy.xyz/checkout.html?plan=3&ref=soak-s2 | 12 | TRIAL, not charged |
| S3 | https://app.getlevy.xyz/checkout.html?plan=4&ref=soak-s3 | **2** | ACTIVE, charged 1 USDC, `allowance.low` (one round left) |
| S4 | https://app.getlevy.xyz/checkout.html?plan=1&ref=soak-s4 | 12 | ACTIVE, charged 1 USDC |

The references are readable on purpose for the soak. Real merchants should use
unguessable ones (docs/merchant-guide.md).

- [ ] (you) S5 subscribes to plan 1 with Permit2. It has no page, so run the script from the repo on your PC:

  ```powershell
  cd D:\REPO\levy
  node keeper\scripts\permit2-subscribe.mjs --plan 1 --ref soak-s5
  ```

  It asks for **S5's** private key (hidden), shows the plan, the wallet and the transactions, and sends nothing until you type `yes`. It then approves Permit2 for 12 cycles (one transaction), signs the permit (no gas) and calls `subscribeWithPermit2` (one transaction), and prints the subscription ID. S5 must be a fresh wallet from `cast wallet new`: the script refuses an address with contract code, because well-known test keys on public testnets are often taken over by EIP-7702 sweepers and Permit2 then rejects the signature.

  Expect ACTIVE and charged 1 USDC, and an `allowance.low` straight away: the keeper does not read Permit2 allowances yet (a known gap), so charges should keep succeeding despite the warning.
- [ ] The dashboard shows five subscriptions with references soak-s1 to soak-s5
- [ ] Record the subscription IDs (S4's is needed on day 2):

| Wallet | Subscription ID | Subscribed at (UTC) |
|---|---|---|
| S1 | | |
| S2 | | |
| S3 | | |
| S4 | | |
| S5 | | |

## Scheduled actions

| When | Who | Action | Expect |
|---|---|---|---|
| Day 0 | you | `& $cast call $mgr "charge(uint256)" <S1 id> --rpc-url $rpc` | Reverts (not due yet): nobody can charge early |
| Day 1 | keeper | S2's trial ends | S2 charged 1 USDC, TRIAL to ACTIVE |
| Day 1 | keeper | S3's second charge | Succeeds; S3's allowance is now 0 |
| Day 2 | keeper | S3's third charge | Fails: `charge.failed`, `dunning.started`, PAST_DUE (plan 4 allows one failure) |
| Day 2 | you | Right after that failure: `& $cast call $mgr "charge(uint256)" <S3 id> --rpc-url $rpc` | Reverts `RetryTooSoon`: nobody can record a second failure within a day of the first (the dunning schedule, enforced on-chain) |
| Day 2 | you | Portal as S2: **Pause** | PAUSED; no charge while paused |
| Day 2.5 | you | S4 upgrades: portal as S4, **Change plan** to plan 2 (check the quoted price), or `& $cast send $mgr "changePlan(uint256,uint256)" <S4 id> 2 --rpc-url $rpc --interactive` (S4's key) | About half a day of plan 1 left becomes about 0.5 USDC of credit, about 1.5 USDC pulled, next charge in 1 day, `subscription.updated` |
| Day 3 | keeper | S3 retry | Fails again: auto-paused (`subscription.paused` with `auto: true`) |
| Day 3 | (none) | S2's billing date passes while paused | No charge |
| Day 4 | you | Portal as S2: **Resume** | Fresh start: charged at resume, next charge 2 days later |
| Day 4 | you | Portal as S3: **Top up**, then **Resume** | Charged at resume, daily again, `allowance.low` clears |
| Day 4 | Claude | `docker restart levy-keeper` just before a due charge | Charge collected once, no double charge, sync resumes |
| Day 4.75 | you | S4 downgrades, six hours after plan 2's day-4.5 charge: portal as S4, **Change plan** to plan 1, or `& $cast send $mgr "changePlan(uint256,uint256)" <S4 id> 1 --rpc-url $rpc --interactive` | 0.75 of a day of plan 2 left becomes 1.5 USDC of credit. Plan 1's first cycle is paid from it (a charge of 0 USDC); the 0.5 left carries, so the next charge a day later pulls only 0.5 USDC |
| Day 7 | you | Portal as S2: **Cancel** | CANCELLED; nothing charged after this |
| Day 7 | you | `& $cast send 0xa6efee5f5a2eb2afae102f790b4889fcc01fe848 "sweep()" --rpc-url $rpc --interactive` (any funded wallet) | The treasury's USDC rises by exactly the fees collected |
| Day 7 | you | Dashboard: Export CSV | One row per charge; totals match the chain |

S1 and S5 are never touched: they should be charged exactly once a day, all
week.

## Daily checks (Claude)

One status run a day, pasted into the log below:

- [ ] Keeper up, synced to within a minute of the chain head, no unhandled errors (rate-limit retries noted separately)
- [ ] Every charge that fell due was collected within 5 minutes of its billing date
- [ ] Per subscription: charge count and status match the schedule above
- [ ] USDC: merchant received 99%, fee router 1% (rounded down), per charge
- [ ] Webhooks: deliveries sent, failed, dead; every signature valid
- [ ] Keeper gas: USDC spent in the last 24 hours and balance left
- [ ] API health, certificate, disk

All of it comes from one command on the soak host (`ssh packrai-vps` from
David's PC):

```bash
bash /docker/levy/ops/soak-status.sh
```

It prints the containers, the keeper's log over the last 24 hours, API
health, the certificate and disk, the receiver's log (signature failures and
which of the ten events have not been seen yet), then, from the chain and the
keeper's database: sync lag, the keeper wallet, every subscription (status,
charges, failures, next charge, credit, and how late its last charge was), the
money (fee rule, fee router balance against recorded fees), dunning, low
allowances and webhook deliveries. It ends with a list of alerts.

## After the soak

Remove the soak-only pieces from the host:

- `docker compose -f /docker/levy/ops/soak/docker-compose.yml down`
- the `location ^~ /soak-hooks` block in `/etc/nginx/sites-available/app.getlevy.xyz`, then `nginx -t && systemctl reload nginx`
- the merchant's webhook endpoint for `/soak-hooks`, in the dashboard

## Stop the soak and investigate if

- any subscription is charged twice for one billing date, charged before it is due, or charged while paused or cancelled
- USDC goes anywhere other than the plan's merchant and the fee router
- the keeper is down or more than 10 minutes behind the chain for over an hour
- a webhook signature fails to verify

## Pass criteria

- [ ] 7 days with the keeper running (restarts allowed; no manual edits to its database)
- [ ] Every due charge collected once, within 5 minutes, all week
- [ ] Trial, dunning (past due, then auto-pause), pause and resume, cancel, upgrade and downgrade with credit, and Permit2 each behaved as expected above
- [ ] All ten event types received at least once, every signature valid, nothing dead-lettered
- [ ] On-chain totals, the database's invoices and the CSV agree to the unit
- [ ] The sweep moved exactly the fees collected to the treasury
- [ ] Keeper gas about 0.002 to 0.003 USDC per charge, as the whitepaper states

When every box is ticked, the soak item under "Before mainnet" in the README is done.

## Log

| Date (UTC) | Who | What happened |
|---|---|---|
| 2026-09-26 | Claude | Contracts deployed (block 64020204); API live at https://app.getlevy.xyz; keeper running from `0cbd30d` with sequential log queries and RPC backoff: no rate-limit errors in its first 10 minutes (about 1 in 5 cycles before) |
| 2026-09-26 | Claude | Soak tools live: receiver at `/soak-hooks` (health ok, public key loaded), `ops/soak-status.sh` (first run: no alerts), Permit2 script tested against a fork of Arc testnet with Arc's real Permit2 |
| 2026-09-26 | Claude | External review (PR #1) found H-1: failures could be recorded back to back. Fixed in `08dd7b7` (at most one recorded failure per day). Contracts redeployed in block 64031023 (SubscriptionManager `0x33c8...739f`); the first deployment is superseded. Keeper and API repointed with a fresh database; the old one is kept in `/root/levy-db-old-contract` on the host |

# Levy Wiki

Levy is pull-based USDC subscription billing on Arc. A merchant creates a plan, a subscriber approves a USDC allowance once, and a keeper triggers each cycle's payment. The protocol keeps 1% of every collected payment and sends the rest to the merchant.

> **Status.** Levy runs on Arc testnet only. Nothing is on mainnet and nothing is audited. The first testnet soak ran from 2026-10-07 to 2026-10-24; the second runs against the contracts deployed on 2026-10-24 with the fixes from that day's review. Current contracts: SubscriptionManager `0xea24ac9c1217a671139d93225fdcf19ea3c4df4e` and FeeRouter `0x9e62309243da8be600a718a323fbbdfce00f3ce8`. See [Deployment](Deployment.md) and [Security](Security.md).

## How it works

1. A merchant creates a plan on-chain: price per cycle, cycle length, optional trial, and how many failed payments to tolerate. Plans are immutable.
2. A subscriber approves a USDC allowance and subscribes, from the hosted checkout page or directly through the contract. Without a trial, the first cycle is charged at once.
3. When a cycle is due, anyone can call `charge()`. The keeper is the always-on caller. The contract can only move the subscriber's pre-approved USDC to that plan's merchant.
4. If a pull fails, the contract records it and the keeper retries on a 1, 3, then 7 day schedule that the contract itself enforces. After twice the plan's tolerance, the subscription pauses automatically.
5. The keeper delivers signed webhooks to the merchant for every step, and the merchant notifies its own customers.
6. Subscribers pause, resume, cancel and change plans from the customer portal, signing with their own wallet.

## Pages

**Start here**

| Page | What it covers |
|---|---|
| [Getting Started](Getting-Started.md) | Clone, build, test and run the whole stack locally |
| [Architecture](Architecture.md) | Components, trust boundaries and the main data flows |
| [Glossary](Glossary.md) | Terms used across the code and docs |

**Smart contracts**

| Page | What it covers |
|---|---|
| [Smart Contracts](Smart-Contracts.md) | The two contracts, their functions, events and invariants |
| [Plans and Subscriptions](Plans-and-Subscriptions.md) | Creating plans, subscribing, and the subscription lifecycle |
| [Charging and Fees](Charging-and-Fees.md) | How a charge works, fee math and the FeeRouter |
| [Dunning and Failures](Dunning-and-Failures.md) | Failed payments, retries, past due and auto-pause |
| [Plan Changes and Proration](Plan-Changes-and-Proration.md) | Upgrades, downgrades and credit |
| [Permit2](Permit2.md) | One-transaction subscribe with a Permit2 signature |

**Keeper**

| Page | What it covers |
|---|---|
| [Keeper Service](Keeper-Service.md) | The charge loop and the webhook loop |
| [Event Indexer and Database](Event-Indexer-and-Database.md) | How chain events become SQLite rows, and the schema |
| [Webhooks](Webhooks.md) | Events, signatures, delivery and retries |
| [Keeper Configuration](Keeper-Configuration.md) | Every environment variable |

**API and web pages**

| Page | What it covers |
|---|---|
| [API Reference](API-Reference.md) | Every route, with access rules and limits |
| [Authentication](Authentication.md) | Wallet sign-in, sessions and cookies |
| [Dashboard, Portal and Checkout](Dashboard-Portal-and-Checkout.md) | The three browser pages |

**Operations and quality**

| Page | What it covers |
|---|---|
| [Deployment](Deployment.md) | Deploying contracts, the keeper and the API |
| [Monitoring and Maintenance](Monitoring-and-Maintenance.md) | Alerts, checks and routine work |
| [Testing](Testing.md) | Unit, invariant, integration and CI tests |
| [Security](Security.md) | Threat model, protections and review history |

## By role

- **Merchants**: [Plans and Subscriptions](Plans-and-Subscriptions.md), [Webhooks](Webhooks.md), [Dunning and Failures](Dunning-and-Failures.md), and the [merchant guide](https://github.com/RunTimeAdmin/levy/blob/main/docs/merchant-guide.md).
- **Developers**: [Getting Started](Getting-Started.md), [Architecture](Architecture.md), [Smart Contracts](Smart-Contracts.md), [API Reference](API-Reference.md).
- **Operators**: [Deployment](Deployment.md), [Monitoring and Maintenance](Monitoring-and-Maintenance.md), [Keeper Configuration](Keeper-Configuration.md).
- **Reviewers**: [Security](Security.md), [Charging and Fees](Charging-and-Fees.md), [Testing](Testing.md).

## Elsewhere in the repository

| Document | Purpose |
|---|---|
| [README](https://github.com/RunTimeAdmin/levy/blob/main/README.md) | Overview, deployments and development commands |
| [SPEC.md](https://github.com/RunTimeAdmin/levy/blob/main/SPEC.md) | The design spec |
| [SECURITY_REVIEW.md](https://github.com/RunTimeAdmin/levy/blob/main/SECURITY_REVIEW.md) | Adversarial self-review and open items |
| [FEE_MATH_AUDIT.md](https://github.com/RunTimeAdmin/levy/blob/main/FEE_MATH_AUDIT.md) | Audit of every arithmetic operation |
| [VERIFICATION.md](https://github.com/RunTimeAdmin/levy/blob/main/VERIFICATION.md) | Verified Arc chain facts |
| [ops/testnet-soak.md](https://github.com/RunTimeAdmin/levy/blob/main/ops/testnet-soak.md) | The testnet soak plan and log |

Public site: [getlevy.xyz](https://getlevy.xyz), with the [merchant docs](https://getlevy.xyz/docs.html) and the [whitepaper](https://getlevy.xyz/whitepaper.html).

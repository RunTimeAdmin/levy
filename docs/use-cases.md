# Levy Use Cases

Recurring USDC billing on Arc, pull-based. The subscriber approves once
(via Permit2 or a standard approval); Levy pulls each cycle. No per-cycle
customer action, on-chain dunning, webhook events for every state change.

## Agent economy

**Agent service subscriptions.** An agent pays for API access, compute, or
data feeds on a schedule. The agent holds an allowance and the provider
pulls each cycle. No per-cycle signing, no missed payments when the agent
is busy.

**Agent-to-agent retainers.** One agent subscribes to another agent's output:
a scoring feed, monitoring, alerts. Recurring USDC, settled on-chain,
auditable from the ledger.

## Crypto-native SaaS

**Dev tool and infrastructure billing.** RPC endpoints, indexers, dashboards,
and analytics sold as monthly USDC plans. The merchant gets plans,
proration, dunning, and webhooks instead of building retry logic.

**Oracle and data feed subscriptions.** A fixed monthly pull for a data
stream. The subscriber cancels in the customer portal.

## Creators and communities

**Paid newsletters and private feeds.** Recurring patronage at a 1% protocol
fee instead of a platform's cut. The customer portal handles pause and
cancel; webhooks tell the merchant who is current.

**Token-gated community dues.** Guilds, clubs, and DAOs collecting monthly
dues in USDC with automatic past-due handling instead of a treasurer chasing
payments.

## Commerce

**On-chain installment plans (not deployed yet).** A fixed number of scheduled
pulls, then the plan ends. The deployed contracts have no cycle count or end
date; a subscription runs until someone cancels it. Manager v2, built on the
`docs/manager-v2-design` branch and not deployed, adds the cycle limit
(`maxCycles`) that buy-now-pay-later without a lender in the middle needs.

**Domain and hosting renewals.** Recurring renewals for portfolios of
domains and servers. The pull fails safe: missed payment triggers dunning,
not silent lapse.

**Tokenized rent collection.** Monthly USDC rent pulled from a tenant
wallet, with dunning when the pull fails and an on-chain record of every
cycle.

## Public goods

**Recurring donations.** Monthly pulls to a project or maintainer. The donor
cancels any time in the customer portal; the recipient sees predictable
inflow.

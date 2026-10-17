# Merchant Onboarding Friction — Strategy Notes

**Date:** 2026-10-15
**Status:** Idea captured, not yet designed or built.
**Context:** Levy's billing engine (keeper, contracts, dashboard, checkout) runs on Arc testnet in the M4 soak. The remaining adoption risk is not the billing logic — it is that a regular SaaS business owner has to be comfortable with wallets and USDC to use it. This doc captures the approach for removing that friction.

---

## The Problem

Today a merchant must:

1. Hold a wallet with USDC
2. Sign in with that wallet (SIWE)
3. Create plans, register webhooks, share checkout links
4. Understand Permit2, allowances, and fee routing well enough to trust the system

That onboarding is fine for crypto-native merchants. It loses the mainstream SaaS owner — the actual revenue base Levy needs before agent commerce scales.

## The Approach: Hide Crypto, Keep the Mental Model

Give merchants an experience identical to Stripe:

- **Email signup** instead of wallet connect as the primary entry
- **Invisible smart-wallet provisioning** — Levy creates and controls a smart wallet on the merchant's behalf; the merchant never sees a seed phrase or address unless they ask
- **Card funding** — merchant tops up in dollars; Levy converts to USDC on the backend (off-ramp/on-ramp partner or treasury conversion)
- **Dashboard in dollars** — plan prices, revenue, fees, and payouts displayed as USD; the USDC layer is an implementation detail
- **Crypto as an upgrade path** — self-custody, direct wallet sign-in, and Permit2 remain available for merchants who want them later

The merchant sees: dollars in, dollars out, subscription rows in a table. Same cognitive model as any SaaS billing tool.

## Open Design Questions

- Which smart-wallet infrastructure (Safe, Coinbase Smart Wallet, Turnkey, or custom) fits Levy's existing TypeScript stack and Arc deployment?
- Who bears conversion spread and card fees — absorbed in Levy's 1% fee, passed to merchant, or both?
- Does card funding require KYC/AML on the merchant, and does that conflict with the crypto-native positioning?
- How does the invisible wallet interact with the existing SIWE auth and dashboard session model?
- What happens to a merchant's funds if they later want to migrate from the managed wallet to self-custody?

## Relation to Existing Work

- `docs/merchant-guide.md` — current merchant-facing docs assume wallet-native onboarding
- `docs/wiki/Authentication.md` — SIWE/EIP-4361 session model that would need a parallel email-session path
- `ops/testnet-soak.md` — the soak tests the billing engine; this onboarding layer sits above it and does not change contract behavior
- AgentClear research (`docs/AGENT_REPUTATION_ALTERNATIVES_RESEARCH.md` in the agentclear repo) — merchant adoption is the distribution wedge that makes Levy's subscription thesis real before agent volume arrives

---

*Captured 2026-10-15 from conversation with Eve. Not a spec — a seed for the next design pass.*
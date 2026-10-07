# Security policy

Levy runs on Arc testnet and has not been audited yet. No real money flows through it, and its contracts never hold funds at rest. Reports now still matter: everything found before mainnet gets fixed before mainnet.

The full policy is at https://getlevy.xyz/security.html, with the same contact in https://getlevy.xyz/.well-known/security.txt.

## Reporting a vulnerability

Email **hello@getlevy.xyz** with "Security" in the subject. Please include:

- what is affected: a contract address, a URL or a component;
- the steps to reproduce it, or a proof of concept;
- the impact you see, and anything you already know about a fix.

Please keep it private until it is fixed or we have agreed a date to publish together. Do not open a public issue for a vulnerability.

## Scope

- The Levy contracts on Arc testnet, `SubscriptionManager` `0x62a6512335d630ef19fcadb497adf98d883f77c6` and `FeeRouter` `0x4819975f4fa3a693ec67539bcb121eb06f280541`, and the mainnet contracts once they are deployed.
- The app at app.getlevy.xyz: the API, merchant dashboard, customer portal and checkout.
- The keeper: charging, dunning, and the signing and delivery of webhooks.
- The website, getlevy.xyz.

Out of scope: Arc itself, USDC, Permit2 and wallets (report those to their owners), denial of service and load testing, social engineering, and scanner output or missing headers without a demonstrated impact.

## Rules for testing

- Test on Arc testnet with your own wallets, plans and subscriptions. Do not touch anyone else's subscriptions, wallets or webhook endpoints.
- Keep automated requests slow. The sign-in endpoint is rate-limited, and flooding the API helps nobody.
- Stop once you can show the impact, and do not keep or share data that is not yours.

## What we commit to

- We acknowledge every report within 3 business days and keep you updated until it is resolved.
- We fix confirmed issues before mainnet, and credit you in our security review if you would like that.
- We will not pursue or support legal action against research that follows this policy in good faith.

Levy does not run a paid bug bounty yet.

Known open issues from our own and external reviews are listed in [SECURITY_REVIEW.md](SECURITY_REVIEW.md) section 9.

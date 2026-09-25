# Levy Pre-Mainnet Verification

Date checked: 2026-09-25. Each item verified against primary sources (Arc Docs, Circle/Arc GitHub, on-chain reads). Verdicts are adversarial: unconfirmed means unconfirmed.

---

## 1. Transaction memos on Arc mainnet

**VERDICT: CONFIRMED — live on mainnet.**

The Memo contract is predeployed on Arc mainnet at `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`, listed under the Mainnet tab on the Arc Docs contract-addresses page. It "attaches memo metadata to contract calls" and emits `Memo` events with a sequential index. The companion `Multicall3From` (`0x522fAf9A91c41c443c66765030741e4AaCe147D0`) is also on mainnet. Both route subcalls through the CallFrom precompile, preserving the original `msg.sender`.

The September 10, 2026 "testnet-only" note is **superseded**. Independent confirmation: the Memoline payout app (Arc Microgrants) is live on mainnet writing invoice references through the Memo contract (demo published ~2026-09-23).

Implication for Levy: invoicing can key off `Memo` events on mainnet. No need to wait.

Sources:
- https://docs.arc.io/arc/references/contract-addresses (accessed 2026-09-25; Memo + Multicall3From under Mainnet)
- https://www.youtube.com/watch?v=FqULZKNOnl8 (Memoline mainnet demo, ~2026-09-23)

---

## 2. PUSH0 / EVM version on Arc mainnet

**VERDICT: CONTRADICTED — the "paris is mandatory" claim does not hold for mainnet.**

Arc mainnet (chain 5042) runs an **Osaka-baseline EVM**. Osaka is three forks past Shanghai (Shanghai < Cancun < Prague < Osaka), and PUSH0 (`0x5f`) was introduced in Shanghai. An Osaka EVM supports PUSH0 by definition. Multiple independent sources agree:

- On-chain read (2026-09-20): "Stack — Malachite BFT + Reth · Osaka EVM · L1" (dev.to, via `web3_clientVersion` = `arc/v1`)
- Client hardfork tables: mainnet gets Zero3, Zero4, Osaka, Zero5, Zero6 all at genesis (shemnon/evm-directory, from arc-node source)
- "EVM baseline: Osaka, active since block 44,287,067 (2026-05-27)"

The PUSH0-rejection reports (GitHub issues circlefin/arc-node#109, osr21/arc-relay-bridge#4) are **testnet-only** (chain 5042002), from ~May 2026, pre-dating or coinciding with the Osaka activation. They do not describe mainnet.

Implication for Levy: `evm_version = "paris"` in `foundry.toml` is **harmless but no longer load-bearing** for mainnet. Paris bytecode runs fine on Osaka. Recommendation: keep paris (it works everywhere, zero downside), but stop describing it as mandatory — the README has been corrected accordingly.

Sources:
- https://dev.to/sulimanmukhtar/arc-chain-in-numbers-one-dollar-two-decimals-and-97000-tokens-in-a-day-4b5o (2026-09-20, on-chain reads)
- https://github.com/shemnon/evm-directory/blob/HEAD/chains/arc/SUMMARY.md (hardfork tables from arc-node source)
- https://github.com/circlefin/arc-node/issues/109 (testnet PUSH0 issue — testnet only)

---

## 3. Finality on Arc mainnet

**VERDICT: CONFIRMED — deterministic single-block finality, ~0.5s blocks, no reorgs.**

Arc uses Malachite BFT (Tendermint-style) consensus: once >2/3 of the permissioned validator set commits a block, it is final and irreversible. There are no reorgs. Reported figures are consistent across sources:

- Block time: ~0.5 seconds (binary.ph, dev.to on-chain read, KyberSwap)
- Finality: "deterministic sub-second finality", "finality in under one second with no reorg risk" (KyberSwap, 1inch, cryptonews.net)
- Testnet benchmark: <350ms finality with 20 validators at 3,000+ TPS (karga80/arc technical reference)

Implication for Levy: the keeper's **zero-confirmation-depth design is correct**. Treat a mined transaction as final after one block. Do not add multi-block confirmation logic — it would only add latency for no safety gain.

Sources:
- https://binary.ph/2026/09/20/arc-chain-unveiled-usdc-gas-0-5-second-blocks-and-97k-tokens-launched-in-one-day/ (2026-09-20)
- https://blog.kyberswap.com/how-to-find-and-buy-trending-tokens-on-arc-chain/ ("finality in under one second with no reorg risk")
- https://dev.to/sulimanmukhtar/arc-chain-in-numbers-one-dollar-two-decimals-and-97000-tokens-in-a-day-4b5o (2026-09-20)

---

## 4. Permit2 on Arc mainnet

**VERDICT: CONFIRMED present — but NOT at the address in the old docs.**

Permit2 **is** deployed on Arc mainnet, but at **`0x000000000022D473030F116dDEE9F6B43aC78BA3`** — not at `0x000000000022D473030F64699cA503418c3a50` (the Ethereum-mainnet canonical address from the old Levy docs).

Primary source: the Arc Docs contract-addresses page lists under "Common Ethereum contracts" → Mainnet:

| Contract | Address |
|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

The same address is listed for testnet. The docs note it is "required for StableFX."

Implication for Levy: the old SPEC.md claim ("Permit2 at canonical addresses") is **wrong on the address**. Any Permit2 integration must target `0x000000000022D473030F116dDEE9F6B43aC78BA3` on Arc, not the Ethereum canonical address. Do not copy-paste the `...c3a50` address — it is not the one Arc documents.

Sources:
- https://docs.arc.io/arc/references/contract-addresses (accessed 2026-09-25; Permit2 under Mainnet "Common Ethereum contracts")

---

## Summary table

| # | Question | Verdict | Old claim status |
|---|---|---|---|
| 1 | Memos on mainnet | Confirmed live | "Testnet-only" — SUPERSEDED |
| 2 | PUSH0 / paris mandatory | Contradicted for mainnet (Osaka EVM) | "Mandatory" — FALSE for mainnet; keep paris as harmless conservative default |
| 3 | Finality | Confirmed: ~0.5s blocks, single-block deterministic finality, no reorgs | "~0.5s / one block final" — CONFIRMED |
| 4 | Permit2 address | Present, but at `...F6B43aC78BA3`, not `...c3a50` | Old address — WRONG, must use Arc's listed address |

## Follow-ups for the Permit2 build (done 2026-09-25)

`subscribeWithPermit2` is implemented and tested against a mock Permit2 on anvil, using `0x000000000022D473030F116dDEE9F6B43aC78BA3` as the Permit2 address on both Arc mainnet and testnet. Before mainnet, verify the address with an `eth_getCode` call and run the end-to-end flow against Arc mainnet.

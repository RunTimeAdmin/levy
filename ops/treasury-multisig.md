# FeeRouter treasury multisig handoff

The 1% protocol fee accrues in `FeeRouter` and is forwarded to `treasury` by
the permissionless `sweep()`. At mainnet deploy the treasury will be a hot EOA;
this plan moves it to a multisig before real fee volume exists.

## Recommended structure: 2-of-3 Safe

- Deploy a Safe (or equivalent multisig) on Arc mainnet, chain ID 5042.
- Threshold 2-of-3. Suggested seats (DC's call — placeholders below):
  1. `SIGNER_1` — DC's primary hardware wallet
  2. `SIGNER_2` — DC's secondary / paper-backup key, stored offline
  3. `SIGNER_3` — trusted third party (accountant, counsel, or co-founder)
- A 2-of-3 survives one lost key and one unresponsive signer. Do not use 1-of-N
  (single point of compromise) or 3-of-3 (single point of liveness failure).

## The handoff call

`setTreasury(address)` is guarded: **only the current treasury can call it**
(`OnlyTreasury`). The handoff transaction must be signed by whatever address
holds the treasury role at the time (the deploy EOA, unless already moved).

```
FeeRouter.setTreasury(<SAFE_ADDRESS>)
```

With cast:

```bash
cast send <FEEROUTER_ADDRESS> "setTreasury(address)" <SAFE_ADDRESS> \
  --rpc-url $LEVY_RPC_URL --private-key <CURRENT_TREASURY_KEY>
```

`TreasuryUpdated(oldTreasury, newTreasury)` is emitted on success.

## Pre-handoff checklist

- [ ] Safe deployed on Arc mainnet (chain 5042); address recorded.
- [ ] All three signers confirmed they hold their keys (test-sign a message).
- [ ] Safe threshold verified on-chain as 2 (read `getThreshold()`).
- [ ] Current `FeeRouter.treasury()` value read and confirmed as the deploy EOA:
      `cast call <FEEROUTER> "treasury()(address)" --rpc-url $LEVY_RPC_URL`
- [ ] Current treasury key available to sign the handoff (one transaction only).
- [ ] A fresh small fee balance exists in the router (or skip the sweep test).

## Handoff

1. Send `setTreasury(<SAFE_ADDRESS>)` from the current treasury key.
2. Wait for confirmation; note the tx hash.

## Post-handoff checklist

- [ ] `cast call <FEEROUTER> "treasury()(address)"` returns the Safe address.
- [ ] `TreasuryUpdated` event observed with old = deploy EOA, new = Safe.
- [ ] Sweep test: `cast send <FEEROUTER> "sweep()" --rpc-url ...` (permissionless,
      anyone can call) and confirm the USDC lands in the Safe.
- [ ] Fee-flow test: run one real `charge()` on a test subscription, confirm
      1% arrives at the Safe via `sweep()`.
- [ ] Deploy EOA key secured or rotated — it no longer controls the treasury,
      but it may still be the keeper key or hold other roles; review and
      minimize its permissions.
- [ ] Record the Safe address in `ops/.env` notes / runbook (not as a secret).

## Notes

- `sweep()` stays permissionless after the handoff — anyone (including the
  keeper) can push accrued fees to the Safe at any time. There is nothing to
  steal by calling it; the destination is fixed.
- If the Safe ever needs replacing, the same flow repeats: the *Safe itself*
  (via a 2-of-3 executed transaction) calls `setTreasury(<NEW_SAFE>)`.
- Phase 2 (LEVY token: 50% buyback-and-burn / 50% staking rewards) changes
  `sweep()` semantics and lands with the token contracts — out of scope here.

# FeeRouter treasury multisig

The 1% protocol fee accrues in `FeeRouter` and is forwarded to `treasury` by the
permissionless `sweep()`. On mainnet the treasury is a multisig from the start:
`script/Deploy.s.sol` refuses to deploy on chain 5042 unless `LEVY_TREASURY` is
a contract. So the order is: deploy the Safe, then deploy Levy with it.

## Recommended structure: 2-of-3 Safe

- Deploy a Safe (or equivalent multisig) on Arc mainnet, chain ID 5042. Safe
  v1.4.1 has code at its canonical addresses on Arc mainnet (checked 2026-10-07, see
  SPEC.md), but the exact versions are unverified; check the Safe deployment on Arc first.
- Threshold 2-of-3. Suggested seats (DC's call; placeholders below):
  1. `SIGNER_1`: DC's primary hardware wallet
  2. `SIGNER_2`: DC's secondary or paper-backup key, stored offline
  3. `SIGNER_3`: a trusted third party (accountant, counsel, or co-founder)
- A 2-of-3 survives one lost key and one unresponsive signer. Do not use 1-of-N
  (single point of compromise) or 3-of-3 (single point of liveness failure).

## Before the mainnet deploy

- [ ] Safe deployed on Arc mainnet (chain 5042); address recorded.
- [ ] All three signers confirmed they hold their keys (test-sign a message).
- [ ] Safe threshold verified on-chain as 2 (read `getThreshold()`).
- [ ] Safe address set as `LEVY_TREASURY` for `script/Deploy.s.sol`.

## After the deploy

- [ ] `cast call <FEEROUTER> "treasury()(address)" --rpc-url $LEVY_RPC_URL`
      returns the Safe address.
- [ ] Sweep test: `cast send <FEEROUTER> "sweep()" --rpc-url ...` (anyone can
      call it) and confirm the USDC lands in the Safe.
- [ ] Fee-flow test: run one real `charge()` on a test subscription, sweep, and
      confirm the 1% arrives at the Safe.
- [ ] Record the Safe address in the ops runbook (it is not a secret).

## Changing the treasury later

A move takes two transactions. `proposeTreasury(address)` is guarded: **only
the current treasury can call it** (`OnlyTreasury`; the zero address reverts
`ZeroAddress`). It stores the address as `pendingTreasury` and emits
`TreasuryProposed(treasury, pendingTreasury)`; proposing again replaces the
proposal. Nothing moves until **the proposed address itself** calls
`acceptTreasury()` (anyone else reverts `OnlyPendingTreasury`), which emits
`TreasuryUpdated(oldTreasury, newTreasury)` and clears `pendingTreasury`. A
mistyped address can therefore never take over the fees.

- **Replacing the Safe:** the old Safe calls `proposeTreasury(<NEW_SAFE>)` as a
  2-of-3 executed transaction, then the new Safe calls `acceptTreasury()` as one
  of its own. In between, confirm the proposal:

  ```bash
  cast call <FEEROUTER_ADDRESS> "pendingTreasury()(address)" --rpc-url $LEVY_RPC_URL
  ```

- **Testnet, or any deploy that started with a plain key** (allowed off
  mainnet): the current key proposes, then the new treasury accepts, e.g.

  ```bash
  cast send <FEEROUTER_ADDRESS> "proposeTreasury(address)" <SAFE_ADDRESS> \
    --rpc-url $LEVY_RPC_URL --private-key <CURRENT_TREASURY_KEY>
  ```

  then `<SAFE_ADDRESS>` executes `acceptTreasury()` as a Safe transaction. A
  plain-key successor accepts with:

  ```bash
  cast send <FEEROUTER_ADDRESS> "acceptTreasury()" \
    --rpc-url $LEVY_RPC_URL --private-key <NEW_TREASURY_KEY>
  ```

After the accept, `cast call <FEEROUTER_ADDRESS> "treasury()(address)"` returns the
new address and `pendingTreasury()` returns zero.

Note that `proposeTreasury` accepts any non-zero address, and a plain key that
accepts becomes the treasury, so the deploy-time check does not stop a later
move away from the Safe. Treat any `TreasuryProposed` or `TreasuryUpdated` event
as something to verify.

## Notes

- `sweep()` stays permissionless: anyone (including the keeper) can push accrued
  fees to the treasury at any time. There is nothing to steal by calling it; the
  destination is fixed.
- Phase 2 (LEVY token: 50% buyback-and-burn / 50% staking rewards) changes
  `sweep()` and lands with the token contracts; out of scope here.

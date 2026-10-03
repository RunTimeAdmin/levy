// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";

/**
 * @title Deploy
 * @notice Deploys FeeRouter and SubscriptionManager, then prints the keeper's
 *         env lines. Checks the chain first: USDC and Permit2 must have code,
 *         USDC must report 6 decimals, and on Arc mainnet the treasury must be
 *         a contract (the Safe from ops/treasury-multisig.md), not a single key.
 *
 * Usage (Arc testnet, chain 5042002; gas is USDC from https://faucet.circle.com):
 *   forge script script/Deploy.s.sol --rpc-url arc_testnet -vvvv              # simulate
 *   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast -vvvv  # deploy
 *   # add --legacy if fee estimation fails
 * Arc mainnet (chain 5042): the same with --rpc-url arc_mainnet.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY  deployer key, pays gas in USDC (never commit it)
 *   LEVY_TREASURY         FeeRouter treasury; must be a contract on mainnet
 * Optional env:
 *   LEVY_USDC             USDC ERC-20 interface (default: Arc's 0x3600...0000)
 *   LEVY_PERMIT2          Permit2 (default: the canonical address)
 */
contract Deploy is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant ARC_MAINNET = 5042;

    error NoCode(address account);
    error WrongDecimals(uint8 decimals);
    error TreasuryNotContract(address treasury);
    error NotCanonical(address given, address expected);

    function run() external returns (FeeRouter router, SubscriptionManager manager) {
        address usdc = vm.envOr("LEVY_USDC", ARC_USDC);
        address permit2 = vm.envOr("LEVY_PERMIT2", PERMIT2);
        address treasury = vm.envAddress("LEVY_TREASURY");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        (router, manager) = deploy(usdc, permit2, treasury);
        vm.stopBroadcast();

        console.log("FeeRouter:  ", address(router));
        console.log("treasury:   ", treasury);
        console.log("deploy block (the keeper must reach back to it; see LEVY_LOOKBACK_BLOCKS):", block.number);
        console.log("");
        console.log("# keeper / ops .env");
        console.log(string.concat("LEVY_CHAIN_ID=", vm.toString(block.chainid)));
        console.log(string.concat("LEVY_MANAGER_ADDRESS=", vm.toString(address(manager))));
        console.log(string.concat("LEVY_USDC_ADDRESS=", vm.toString(usdc)));
    }

    /// @notice Checks the chain, then deploys. Separate from run() so tests can call it.
    function deploy(address usdc, address permit2, address treasury)
        public
        returns (FeeRouter router, SubscriptionManager manager)
    {
        if (usdc.code.length == 0) revert NoCode(usdc);
        if (permit2.code.length == 0) revert NoCode(permit2);
        uint8 decimals = IERC20Metadata(usdc).decimals();
        if (decimals != 6) revert WrongDecimals(decimals);
        if (block.chainid == ARC_MAINNET) {
            // Both become immutable in the manager: on mainnet only Arc's own
            // USDC and the canonical Permit2 are accepted, whatever the env says.
            if (usdc != ARC_USDC) revert NotCanonical(usdc, ARC_USDC);
            if (permit2 != PERMIT2) revert NotCanonical(permit2, PERMIT2);
            if (treasury.code.length == 0) revert TreasuryNotContract(treasury);
        }

        router = new FeeRouter(usdc, treasury);
        manager = new SubscriptionManager(usdc, address(router), permit2);
    }
}

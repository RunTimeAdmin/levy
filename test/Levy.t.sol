// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {IPermit2} from "../src/IPermit2.sol";
import {basicTerms} from "./Terms.sol";

contract LevyTest is Test {
    MockUSDC usdc;
    FeeRouter router;
    SubscriptionManager manager;
    MockPermit2 permit2;

    address merchant = makeAddr("merchant");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    uint256 constant PRICE = 10_000_000; // $10.00 in 6-decimal units
    uint256 constant CYCLE = 30 days;
    uint256 planId;

    function setUp() public {
        usdc = new MockUSDC();
        router = new FeeRouter(address(usdc), treasury);
        permit2 = new MockPermit2();
        manager = new SubscriptionManager(address(usdc), address(router), address(permit2));

        vm.prank(merchant);
        planId = manager.createPlan(merchant, basicTerms(PRICE, CYCLE, 0, 2));

        usdc.mint(alice, 1_000_000_000); // $1,000
    }

    // ---- plan creation ----

    function testCreatePlan() public view {
        (
            address m,
            uint256 price,
            uint256 cycle,
            uint256 trial,
            uint8 maxFailed,
            bool exists,
            ,
            ,
            ,
            ,
        ) = manager.plans(planId);
        assertEq(m, merchant);
        assertEq(price, PRICE);
        assertEq(cycle, CYCLE);
        assertEq(trial, 0);
        assertEq(maxFailed, 2);
        assertTrue(exists);
    }

    function testCreatePlanRevertsOnZeroPrice() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, basicTerms(0, CYCLE, 0, 2));
    }

    function testCreatePlanRequiresOneDayCycle() public {
        // A shorter cycle would let a self-paying subscription cost the keeper
        // gas every few seconds, and a mistaken approval drain that fast.
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, basicTerms(PRICE, 1 days - 1, 0, 2));
        vm.prank(merchant);
        manager.createPlan(merchant, basicTerms(PRICE, 1 days, 0, 2));
        assertEq(manager.MIN_CYCLE(), 1 days);
    }

    function testCreatePlanRevertsOnTrialLongerThanCycle() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, basicTerms(PRICE, CYCLE, CYCLE, 2));
    }

    // ---- subscribe ----

    function testSubscribeNoTrial() public {
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        vm.prank(alice);
        uint256 subId = manager.subscribe(planId, bytes32(0));
        (
            address subscriber,
            ,
            uint64 start,
            uint64 nextCharge,
            ,
            ,
            uint256 chargeCount,
            SubscriptionManager.Status status
        ) = manager.subscriptions(subId);
        assertEq(subscriber, alice);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(nextCharge, start + CYCLE);
        // Advance billing: the first cycle is paid at subscribe.
        assertEq(chargeCount, 1);
        assertEq(usdc.balanceOf(merchant), PRICE - PRICE / 100);
        assertEq(usdc.balanceOf(address(router)), PRICE / 100);
    }

    function testSubscribeRecordsMerchantRef() public {
        bytes32 ref = keccak256("checkout-session-7f3a"); // opaque, as merchants should use
        vm.prank(alice);
        usdc.approve(address(manager), PRICE);
        vm.expectEmit(true, true, true, true, address(manager));
        emit SubscriptionManager.Subscribed(1, alice, planId, uint64(block.timestamp + CYCLE), ref);
        vm.prank(alice);
        uint256 subId = manager.subscribe(planId, ref);
        assertEq(manager.subscriptionRef(subId), ref);
    }

    function testSubscribeWithoutRefStoresNothing() public {
        uint256 subId = _subscribeAndApprove();
        assertEq(manager.subscriptionRef(subId), bytes32(0));
    }

    function testSubscribeWithoutAllowanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.PaymentFailed.selector);
        manager.subscribe(planId, bytes32(0));
    }

    function testSubscribeWithTrial() public {
        vm.prank(merchant);
        uint256 trialPlan = manager.createPlan(merchant, basicTerms(PRICE, CYCLE, 7 days, 2));
        vm.prank(alice);
        uint256 subId = manager.subscribe(trialPlan, bytes32(0));
        (, , uint64 start, uint64 nextCharge, , , uint256 chargeCount, SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.TRIAL));
        assertEq(nextCharge, start + 7 days);
        assertEq(chargeCount, 0); // trial: nothing pulled, no allowance needed
    }

    function testSubscribeUnknownPlanReverts() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.UnknownPlan.selector);
        manager.subscribe(999, bytes32(0));
    }

    // ---- charge ----

    /// @dev Approves 12 cycles, then subscribes (which pays the first cycle).
    function _subscribeAndApprove() internal returns (uint256 subId) {
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        vm.prank(alice);
        subId = manager.subscribe(planId, bytes32(0));
    }

    /// @dev Approves exactly one cycle, so every pull after subscribe fails.
    function _subscribeOneCycleOnly() internal returns (uint256 subId) {
        vm.prank(alice);
        usdc.approve(address(manager), PRICE);
        vm.prank(alice);
        subId = manager.subscribe(planId, bytes32(0));
    }

    function testChargeSplits99And1() public {
        uint256 subId = _subscribeAndApprove();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);

        uint256 merchantBefore = usdc.balanceOf(merchant);
        uint256 routerBefore = usdc.balanceOf(address(router));
        vm.prank(keeper);
        manager.charge(subId);

        assertEq(usdc.balanceOf(merchant) - merchantBefore, PRICE - PRICE / 100);
        assertEq(usdc.balanceOf(address(router)) - routerBefore, PRICE / 100);

        (, , , uint64 nextChargeAfter, , , uint256 chargeCount, SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(nextChargeAfter, nextCharge + CYCLE);
        assertEq(chargeCount, 2);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function testChargeTooEarlyReverts() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
    }

    function testChargeWithoutAllowanceRecordsFailure() public {
        uint256 subId = _subscribeOneCycleOnly(); // allowance spent on cycle 1
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);

        uint256 merchantBefore = usdc.balanceOf(merchant);
        vm.prank(keeper);
        manager.charge(subId); // must NOT revert

        (, , , , uint64 failed, , , SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(usdc.balanceOf(merchant), merchantBefore);
    }

    function testPastDueThenAutoPause() public {
        uint256 subId = _subscribeOneCycleOnly();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);

        // maxFailed = 2: attempts 1-2 -> PAST_DUE at 2, PAUSED at 4
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(nextCharge + i * CYCLE);
            vm.prank(keeper);
            manager.charge(subId);
        }
        (, , , , uint64 failed, , , SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(failed, 4);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));

        // Paused subscriptions are not chargeable
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
    }

    function testResumeAndChargeAfterReapproval() public {
        uint256 subId = _subscribeOneCycleOnly();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(nextCharge + i * CYCLE);
            vm.prank(keeper);
            manager.charge(subId);
        }

        vm.prank(alice);
        manager.resumeSubscription(subId);
        (, , , , uint64 failed, , , ) = manager.subscriptions(subId);
        assertEq(failed, 0); // resume starts a fresh dunning run
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);

        vm.prank(keeper);
        manager.charge(subId);
        assertEq(usdc.balanceOf(merchant), 2 * (PRICE - PRICE / 100));
        // The overdue cycles before the auto-pause are forgiven, not caught up.
        assertFalse(manager.isChargeable(subId));
    }

    function testLargeMaxFailedStillRecordsFailures() public {
        // maxFailed * 2 once overflowed uint8 for maxFailed >= 128, so a
        // failed pull reverted instead of being recorded (found 2026-09-25).
        vm.prank(merchant);
        uint256 lenient = manager.createPlan(merchant, basicTerms(PRICE, CYCLE, 0, 200));
        vm.prank(alice);
        usdc.approve(address(manager), PRICE); // one cycle, spent at subscribe
        vm.prank(alice);
        uint256 subId = manager.subscribe(lenient, bytes32(0));
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);
        manager.charge(subId); // must record the failure, not revert
        (, , , , uint64 failed, , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function testResumeDoesNotBillPausedCycles() public {
        uint256 subId = _subscribeAndApprove(); // cycle 1 paid
        vm.prank(alice);
        manager.pauseSubscription(subId);
        vm.warp(block.timestamp + 180 days);
        vm.prank(alice);
        manager.resumeSubscription(subId);

        // Billing restarts at the resume: one charge now, then nothing is due.
        uint256 resumedAt = block.timestamp;
        assertTrue(manager.isChargeable(subId));
        vm.prank(keeper);
        manager.charge(subId);
        assertFalse(manager.isChargeable(subId));
        (, , , uint64 nextCharge, , , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(nextCharge, resumedAt + CYCLE);
        assertEq(chargeCount, 2);
        assertEq(usdc.balanceOf(merchant), 2 * (PRICE - PRICE / 100));
    }

    function testResumeBeforeNextChargeKeepsSchedule() public {
        uint256 subId = _subscribeAndApprove();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.prank(alice);
        manager.pauseSubscription(subId);
        vm.warp(block.timestamp + 10 days);
        vm.prank(alice);
        manager.resumeSubscription(subId);
        (, , , uint64 nextChargeAfter, , , , ) = manager.subscriptions(subId);
        assertEq(nextChargeAfter, nextCharge); // still inside the paid cycle
    }

    function testResumedSubscriptionGetsFullDunningRun() public {
        uint256 subId = _subscribeOneCycleOnly();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(nextCharge + i * CYCLE);
            manager.charge(subId); // auto-pauses on the 4th failure
        }
        vm.prank(alice);
        manager.resumeSubscription(subId);

        // Still no allowance: the next failure starts a new count instead of
        // pushing past 2 * maxFailed and re-pausing at once.
        manager.charge(subId);
        (, , , , uint64 failed, , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function testChargeFailurePreservesCredit() public {
        // Alice downgrades from $10 to $8 three days into a paid cycle:
        // $9 unused credit, $8 of it pays the new plan's first cycle, $1 is
        // left over. Her allowance then lapses; the $7 pull fails and the $1
        // credit must survive.
        vm.prank(merchant);
        uint256 eightDollarPlan = manager.createPlan(merchant, basicTerms(8_000_000, CYCLE, 0, 10));
        uint256 subId = _subscribeAndApprove();

        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        manager.changePlan(subId, eightDollarPlan);

        // Drain allowance so the next pull fails
        vm.prank(alice);
        usdc.approve(address(manager), 0);
        (, , , uint64 nextCharge, , uint256 creditBefore, , ) = manager.subscriptions(subId);
        assertEq(creditBefore, 1_000_000);

        vm.warp(nextCharge);
        vm.prank(keeper);
        manager.charge(subId); // fails, must not revert, must keep credit

        (, , , , uint64 failed, uint256 creditAfter, , ) = manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(creditAfter, 1_000_000);
    }

    // ---- regressions: back-billing after failures (M-2, 2026-10-24 review) ----

    function testPastDueRecoveryPullsOneCycle() public {
        // A daily $5 plan fails for 24 days, then the subscriber tops up $200.
        // Once, not 24 times: the missed days are forgiven, as resume does.
        vm.prank(merchant);
        uint256 daily = manager.createPlan(merchant, basicTerms(5_000_000, 1 days, 0, 3));
        vm.prank(alice);
        usdc.approve(address(manager), 5_000_000); // one cycle, spent at subscribe
        vm.prank(alice);
        uint256 subId = manager.subscribe(daily, bytes32(0));
        (, , , uint64 due, , , , ) = manager.subscriptions(subId);

        uint256[5] memory failDays = [uint256(0), 1, 4, 11, 18]; // the dunning schedule
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(due + failDays[i] * 1 days);
            manager.charge(subId);
        }
        (, , , , , , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAST_DUE));

        vm.warp(due + 24 days);
        vm.prank(alice);
        usdc.approve(address(manager), 200_000_000);
        uint256 merchantBefore = usdc.balanceOf(merchant);
        manager.charge(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId); // the backlog cannot be pulled in the same block
        assertEq(usdc.balanceOf(merchant) - merchantBefore, 5_000_000 - 50_000);

        uint64 next;
        uint64 failed;
        (, , , next, failed, , , status) = manager.subscriptions(subId);
        assertEq(next, block.timestamp + 1 days); // a fresh cycle from the payment
        assertEq(failed, 0);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function testRecoveryStartsAFreshCycle() public {
        uint256 subId = _subscribeOneCycleOnly();
        (, , , uint64 due, , , , ) = manager.subscriptions(subId);
        vm.warp(due);
        manager.charge(subId); // fails
        vm.warp(due + 3 days);
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        manager.charge(subId);
        // The three late days are forgiven; the paid cycle starts at the payment.
        (, , , uint64 next, uint64 failed, , , ) = manager.subscriptions(subId);
        assertEq(next, block.timestamp + CYCLE);
        assertEq(failed, 0);
    }

    function testChargeAfterAnOutageSkipsEndedCycles() public {
        // Nobody charged for three cycles (say the keeper was down). One pull
        // starts a fresh cycle; the cycles that ended are not billed in a burst.
        uint256 subId = _subscribeAndApprove();
        (, , , uint64 due, , , , ) = manager.subscriptions(subId);
        vm.warp(due + 3 * CYCLE + 1 days);
        manager.charge(subId);
        assertFalse(manager.isChargeable(subId));
        (, , , uint64 next, , , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(next, block.timestamp + CYCLE);
        assertEq(chargeCount, 2);
    }

    function testLateChargeKeepsTheBillingDate() public {
        uint256 subId = _subscribeAndApprove();
        (, , , uint64 due, , , , ) = manager.subscriptions(subId);
        vm.warp(due + 2 hours); // the keeper is a little late, nothing failed
        manager.charge(subId);
        (, , , uint64 next, , , , ) = manager.subscriptions(subId);
        assertEq(next, due + CYCLE);
    }

    // ---- proration ----

    function testChangePlanProrates() public {
        uint256 subId = _subscribeAndApprove(); // paid $10 for cycle 1
        vm.prank(merchant);
        uint256 priceyPlan = manager.createPlan(merchant, basicTerms(PRICE * 2, CYCLE, 0, 2));

        vm.warp(block.timestamp + 15 days); // exactly half the paid cycle used
        uint256 merchantBefore = usdc.balanceOf(merchant);
        vm.prank(alice);
        manager.changePlan(subId, priceyPlan);

        // The $20 plan starts now: $20 - $5 unused credit = $15 pulled now.
        assertEq(usdc.balanceOf(merchant) - merchantBefore, 15_000_000 - 150_000);
        (, uint256 newPlanId, , uint64 nextCharge, , uint256 credit, uint256 chargeCount,) =
            manager.subscriptions(subId);
        assertEq(newPlanId, priceyPlan);
        assertEq(credit, 0);
        assertEq(chargeCount, 2);
        assertEq(nextCharge, block.timestamp + CYCLE);

        // The following cycle is the full $20.
        vm.warp(nextCharge);
        merchantBefore = usdc.balanceOf(merchant);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(usdc.balanceOf(merchant) - merchantBefore, 20_000_000 - 200_000);
    }

    function testDowngradeCreditCoversLaterCycles() public {
        vm.prank(merchant);
        uint256 twoDollarPlan = manager.createPlan(merchant, basicTerms(2_000_000, CYCLE, 0, 2));
        uint256 subId = _subscribeAndApprove(); // paid $10

        // Downgrade immediately: $10 unused credit, $2 pays the new cycle now.
        vm.prank(alice);
        manager.changePlan(subId, twoDollarPlan);
        (, , , , , uint256 credit, , ) = manager.subscriptions(subId);
        assertEq(credit, 8_000_000);

        // The next four cycles are covered by credit: nothing moves.
        uint256 aliceBefore = usdc.balanceOf(alice);
        for (uint256 i = 0; i < 4; i++) {
            (, , , uint64 next, , , , ) = manager.subscriptions(subId);
            vm.warp(next);
            manager.charge(subId);
        }
        assertEq(usdc.balanceOf(alice), aliceBefore);
        (, , , , , credit, , ) = manager.subscriptions(subId);
        assertEq(credit, 0);
    }

    function testChangePlanDuringTrialGivesNoCredit() public {
        vm.prank(merchant);
        uint256 trialPlan = manager.createPlan(merchant, basicTerms(PRICE, CYCLE, 7 days, 2));
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        vm.prank(alice);
        uint256 subId = manager.subscribe(trialPlan, bytes32(0));

        // Unused trial days were never paid for, so they are worth nothing.
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        manager.changePlan(subId, planId);
        (, , , , , uint256 credit, , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(credit, 0);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(usdc.balanceOf(merchant), PRICE - PRICE / 100);
    }

    function testChangePlanWithoutPaymentReverts() public {
        uint256 subId = _subscribeOneCycleOnly();
        vm.prank(merchant);
        uint256 priceyPlan = manager.createPlan(merchant, basicTerms(PRICE * 2, CYCLE, 0, 2));
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.PaymentFailed.selector);
        manager.changePlan(subId, priceyPlan);
    }

    function testChangePlanToSamePlanReverts() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.SamePlan.selector);
        manager.changePlan(subId, planId);
    }

    function testChangePlanToOtherMerchantReverts() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(bob);
        uint256 bobPlan = manager.createPlan(bob, basicTerms(PRICE, CYCLE, 0, 2));
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.DifferentMerchant.selector);
        manager.changePlan(subId, bobPlan);
    }

    // ---- regressions: unbacked proration credit (found 2026-09-25) ----

    function testSelfPricedPlanCannotFundAnotherMerchant() public {
        // Old exploit: subscribe unpaid to a self-made 1e30 plan, switch to a
        // real merchant's plan, ride the 1e30 credit forever.
        address attacker = makeAddr("attacker");
        vm.startPrank(attacker);
        uint256 selfPlan = manager.createPlan(attacker, basicTerms(1e30, CYCLE, 0, 1));
        vm.expectRevert(SubscriptionManager.PaymentFailed.selector);
        manager.subscribe(selfPlan, bytes32(0)); // the 1e30 is now owed up front

        // Even a genuinely paid self-plan cannot move credit to another merchant.
        uint256 cheapSelfPlan = manager.createPlan(attacker, basicTerms(PRICE, CYCLE, 0, 1));
        usdc.mint(attacker, PRICE);
        usdc.approve(address(manager), PRICE);
        uint256 subId = manager.subscribe(cheapSelfPlan, bytes32(0));
        vm.expectRevert(SubscriptionManager.DifferentMerchant.selector);
        manager.changePlan(subId, planId);
        vm.stopPrank();
    }

    function testPlanHoppingStillPaysEveryCycle() public {
        // Old exploit: hop plans a second before each charge so nextChargeAt
        // keeps moving and nothing is ever pulled.
        vm.prank(merchant);
        uint256 otherPlan = manager.createPlan(merchant, basicTerms(PRICE, CYCLE, 0, 2));
        uint256 subId = _subscribeAndApprove();
        for (uint256 i = 0; i < 6; i++) {
            (, uint256 cur, , uint64 next, , , , ) = manager.subscriptions(subId);
            vm.warp(next - 1);
            vm.prank(alice);
            manager.changePlan(subId, cur == planId ? otherPlan : planId);
        }
        // Seven cycles started (subscribe + six hops); each was paid in full
        // apart from the one second of unused credit carried at each hop.
        (, , , , , , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(chargeCount, 7);
        assertGe(usdc.balanceOf(merchant), 7 * (PRICE - PRICE / 100) - 6 * 100);
    }

    // ---- pause / cancel / access control ----

    function testCancelStopsCharges() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(alice);
        manager.cancelSubscription(subId);

        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge + 1);
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
    }

    function testStrangerCannotCancel() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotSubscriberOrMerchant.selector);
        manager.cancelSubscription(subId);
    }

    function testMerchantCanPause() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(merchant);
        manager.pauseSubscription(subId);
        (, , , , , , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));
    }

    // ---- regressions: merchant resume (M-1, 2026-10-24 review) ----

    function testMerchantCannotResumeSubscriberPause() public {
        // Pausing is how a subscriber stops paying without cancelling; a
        // merchant resume would restart billing against their wishes.
        uint256 subId = _subscribeAndApprove();
        vm.prank(alice);
        manager.pauseSubscription(subId);
        assertFalse(manager.pausedByMerchant(subId));
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotSubscriber.selector);
        manager.resumeSubscription(subId);

        vm.prank(alice);
        manager.resumeSubscription(subId);
        (, , , , , , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    function testMerchantCannotResumeAutoPause() public {
        // Dunning gave up on this subscription; restarting it needs the
        // subscriber, even after an earlier merchant pause and resume.
        uint256 subId = _subscribeOneCycleOnly();
        vm.startPrank(merchant);
        manager.pauseSubscription(subId);
        manager.resumeSubscription(subId);
        vm.stopPrank();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(nextCharge + i * CYCLE);
            manager.charge(subId); // auto-pauses on the 4th failure
        }
        (, , , , , , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.PAUSED));

        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotSubscriber.selector);
        manager.resumeSubscription(subId);
        vm.prank(alice);
        manager.resumeSubscription(subId);
    }

    function testMerchantCanResumeOwnPause() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(merchant);
        manager.pauseSubscription(subId);
        assertTrue(manager.pausedByMerchant(subId));
        vm.prank(merchant);
        manager.resumeSubscription(subId);
        assertFalse(manager.pausedByMerchant(subId));
    }

    function testSubscriberCanResumeMerchantPause() public {
        uint256 subId = _subscribeAndApprove();
        vm.prank(merchant);
        manager.pauseSubscription(subId);
        vm.prank(alice);
        manager.resumeSubscription(subId);
        assertFalse(manager.pausedByMerchant(subId));
        (, , , , , , , SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.ACTIVE));
    }

    // ---- fee math ----

    function testFeeRoundsDown() public {
        // $1.50 pull -> fee $0.015 -> 1500 units exactly; $1.51 -> 1510.
        // Dust case: price 199 units -> fee 1 (199/100), merchant keeps 198.
        vm.prank(merchant);
        uint256 dustPlan = manager.createPlan(merchant, basicTerms(199, CYCLE, 0, 2));
        vm.prank(alice);
        usdc.approve(address(manager), 199 * 12);
        vm.prank(alice);
        uint256 subId = manager.subscribe(dustPlan, bytes32(0)); // cycle 1
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);
        vm.prank(keeper);
        manager.charge(subId); // cycle 2
        assertEq(usdc.balanceOf(address(router)), 2);
        assertEq(usdc.balanceOf(merchant), 396);
    }

    // ---- fee router ----

    function testFeeRouterSweep() public {
        uint256 subId = _subscribeAndApprove();
        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);
        vm.prank(keeper);
        manager.charge(subId);

        uint256 fee = PRICE / 100;
        vm.prank(bob); // anyone can sweep; destination is fixed
        router.sweep();
        assertEq(usdc.balanceOf(treasury), 2 * fee); // subscribe + one charge
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testFeeRouterTreasuryMoveIsTwoStep() public {
        // A mistyped successor must never take over the fees (L-3, 2026-10-24 review).
        vm.prank(bob);
        vm.expectRevert(FeeRouter.OnlyTreasury.selector);
        router.proposeTreasury(bob);

        vm.prank(treasury);
        router.proposeTreasury(bob);
        assertEq(router.treasury(), treasury); // nothing moves until bob accepts
        assertEq(router.pendingTreasury(), bob);

        vm.prank(alice);
        vm.expectRevert(FeeRouter.OnlyPendingTreasury.selector);
        router.acceptTreasury();

        vm.prank(bob);
        router.acceptTreasury();
        assertEq(router.treasury(), bob);
        assertEq(router.pendingTreasury(), address(0));
    }

    // ---- permit2 ----

    uint256 constant SIGNER_KEY = 0xB0B5;

    function _signer() internal returns (address s) {
        s = vm.addr(SIGNER_KEY);
        if (usdc.balanceOf(s) == 0) usdc.mint(s, 1_000_000_000);
    }

    function _signPermit(
        address owner,
        address token,
        uint160 amount,
        address spender,
        uint256 sigDeadline
    ) internal view returns (IPermit2.PermitSingle memory p, bytes memory sig) {
        uint48 nonce = permit2.nonce(owner, token, spender);
        p = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: token,
                amount: amount,
                expiration: uint48(block.timestamp + 365 days),
                nonce: nonce
            }),
            spender: spender,
            sigDeadline: sigDeadline
        });
        bytes32 detailsHash = keccak256(
            abi.encode(
                keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"),
                token,
                amount,
                p.details.expiration,
                nonce
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                permit2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
                            "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
                        ),
                        detailsHash,
                        spender,
                        sigDeadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function testPermit2ArcAddress() public view {
        // Arc mainnet/testnet Permit2: the canonical address.
        assertEq(
            manager.PERMIT2_ARC(),
            0x000000000022D473030F116dDEE9F6B43aC78BA3
        );
    }

    function testSubscribeWithPermit2FullFlow() public {
        address s = _signer();
        // Mirrors real Permit2: owner approve()s the Permit2 contract once.
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);

        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(s);
        uint256 subId = manager.subscribeWithPermit2(planId, bytes32("cust-42"), p, sig);
        assertEq(manager.subscriptionRef(subId), bytes32("cust-42"));

        (address subscriber, , , uint64 nextCharge, , , , SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(subscriber, s);
        assertTrue(status == SubscriptionManager.Status.ACTIVE);

        // No direct ERC-20 allowance; both pulls must go through Permit2.
        assertEq(usdc.allowance(s, address(manager)), 0);
        vm.warp(nextCharge);
        vm.prank(keeper);
        manager.charge(subId);

        uint256 fee = PRICE / 100;
        assertEq(usdc.balanceOf(merchant), 2 * (PRICE - fee));
        assertEq(usdc.balanceOf(address(router)), 2 * fee);
        // Permit2 allowance was spent down by two cycles (subscribe + charge).
        (uint160 left, , ) = permit2.allowance(s, address(usdc), address(manager));
        assertEq(left, PRICE * 12 - 2 * PRICE);
    }

    function testSubscribeWithPermit2SurvivesFrontRunPermit() public {
        // Someone copies the signed permit from the mempool and submits it to
        // Permit2 first, using up its nonce (L-2, 2026-10-24 review). The
        // allowance it sets is the one the subscriber signed, so subscribe goes on.
        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(keeper);
        permit2.permit(s, p, sig);

        vm.prank(s);
        uint256 subId = manager.subscribeWithPermit2(planId, bytes32(0), p, sig);
        (address subscriber, , , , , , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(subscriber, s);
        assertEq(chargeCount, 1);
    }

    function testSubscribeWithPermit2FailedPermitNeedsOneCycleAllowance() public {
        // The front-run permit was for less than one cycle: nothing to fall
        // back on, so Permit2's own error comes through.
        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE - 1),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(keeper);
        permit2.permit(s, p, sig);

        vm.prank(s);
        vm.expectRevert(MockPermit2.BadNonce.selector);
        manager.subscribeWithPermit2(planId, bytes32(0), p, sig);
    }

    function testSubscribeWithPermit2FallbackUsesTheIntroPrice() public {
        // The front-run permit covers a $1 intro cycle but not the $10 full
        // price; the first cycle is what it has to cover.
        SubscriptionManager.PlanTerms memory t = basicTerms(PRICE, CYCLE, 0, 2);
        t.introPrice = 1_000_000;
        t.introCycles = 1;
        vm.prank(merchant);
        uint256 promo = manager.createPlan(merchant, t);

        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(1_000_000),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(keeper);
        permit2.permit(s, p, sig);

        vm.prank(s);
        uint256 subId = manager.subscribeWithPermit2(promo, bytes32(0), p, sig);
        (, , , , , , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(chargeCount, 1);
    }

    function testSubscribeWithPermit2IgnoresExpiredAllowance() public {
        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(s);
        permit2.permit(s, p, sig);
        vm.warp(block.timestamp + 366 days); // the allowance has expired, and the signature too

        vm.prank(s);
        vm.expectRevert(MockPermit2.ExpiredPermit.selector);
        manager.subscribeWithPermit2(planId, bytes32(0), p, sig);
    }

    function testSubscribeWithPermit2OnlySignerCanSubmit() public {
        // A relayer holding s's signed permit could otherwise subscribe s to a
        // plan of the relayer's choosing and pull the first cycle at once.
        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        vm.prank(keeper);
        uint256 keeperPlan = manager.createPlan(keeper, basicTerms(PRICE * 12, CYCLE, 0, 1));

        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(keeper);
        vm.expectRevert(MockPermit2.BadSignature.selector); // checked against msg.sender
        manager.subscribeWithPermit2(keeperPlan, bytes32(0), p, sig);
        assertEq(usdc.balanceOf(keeper), 0);
    }

    function testSubscribeWithPermit2BadSpenderReverts() public {
        address s = _signer();
        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(0xBEEF), // not the manager
            block.timestamp + 1 hours
        );
        vm.prank(s);
        vm.expectRevert(SubscriptionManager.BadPermitSpender.selector);
        manager.subscribeWithPermit2(planId, bytes32(0), p, sig);
    }

    function testSubscribeWithPermit2BadTokenReverts() public {
        address s = _signer();
        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(0xDEAD), // not USDC
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(s);
        vm.expectRevert(SubscriptionManager.BadPermitToken.selector);
        manager.subscribeWithPermit2(planId, bytes32(0), p, sig);
    }

    function testSubscribeWithPermit2BadSignatureReverts() public {
        address s = _signer();
        (IPermit2.PermitSingle memory p, ) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        // Signature from a different key.
        bytes memory badSig = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
        vm.prank(s);
        vm.expectRevert(MockPermit2.BadSignature.selector);
        manager.subscribeWithPermit2(planId, bytes32(0), p, badSig);
    }

    function testDirectAllowanceStillTakesPriority() public {
        // Subscriber with BOTH allowances: direct transferFrom wins.
        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        vm.prank(s);
        usdc.approve(address(manager), PRICE * 12);

        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(s);
        uint256 subId = manager.subscribeWithPermit2(planId, bytes32(0), p, sig);

        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);
        vm.prank(keeper);
        manager.charge(subId);

        // Direct allowance paid both cycles (subscribe + charge), Permit2 untouched.
        assertEq(usdc.allowance(s, address(manager)), PRICE * 12 - 2 * PRICE);
        (uint160 permit2Left, , ) = permit2.allowance(s, address(usdc), address(manager));
        assertEq(permit2Left, PRICE * 12);
    }
}

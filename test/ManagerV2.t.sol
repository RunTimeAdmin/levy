// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {basicTerms} from "./Terms.sol";

/// @dev USDC with a blocklist, as Circle's has: any transfer to or from a
///      blocked address reverts.
contract BlocklistUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocklisted");
        super._update(from, to, value);
    }
}

/// @notice v2 (docs/manager-v2-design.md): merchant accounts with a payout and
///         an owner, retiring plans, cycle limits, intro pricing and moving a
///         subscription to a new wallet.
contract ManagerV2Test is Test {
    BlocklistUSDC usdc;
    SubscriptionManager manager;

    address merchant = makeAddr("merchant");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address safe = makeAddr("safe");
    address newOwner = makeAddr("new-owner");

    uint256 constant PRICE = 10_000_000; // $10
    uint256 constant INTRO = 1_000_000; // $1
    uint256 constant CYCLE = 30 days;
    uint256 constant MINTED = 1_000_000_000; // $1,000 each for alice and bob
    uint256 planId; // not transferable, no limit, no intro

    function setUp() public {
        usdc = new BlocklistUSDC();
        FeeRouter router = new FeeRouter(address(usdc), makeAddr("treasury"));
        manager = new SubscriptionManager(address(usdc), address(router), address(new MockPermit2()));
        planId = _plan(_terms(PRICE));

        usdc.mint(alice, MINTED);
        usdc.mint(bob, MINTED);
        vm.prank(alice);
        usdc.approve(address(manager), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(manager), type(uint256).max);
    }

    function _terms(uint256 price) internal pure returns (SubscriptionManager.PlanTerms memory) {
        return basicTerms(price, CYCLE, 0, 2);
    }

    function _plan(SubscriptionManager.PlanTerms memory t) internal returns (uint256 id) {
        vm.prank(merchant);
        id = manager.createPlan(merchant, t);
    }

    function _limited(uint32 maxCycles) internal returns (uint256) {
        SubscriptionManager.PlanTerms memory t = _terms(PRICE);
        t.maxCycles = maxCycles;
        return _plan(t);
    }

    function _intro(uint32 introCycles) internal returns (uint256) {
        SubscriptionManager.PlanTerms memory t = _terms(PRICE);
        t.introPrice = INTRO;
        t.introCycles = introCycles;
        return _plan(t);
    }

    function _transferable(uint256 price) internal returns (uint256) {
        SubscriptionManager.PlanTerms memory t = _terms(price);
        t.transferable = true;
        return _plan(t);
    }

    function _subscribe(address who, uint256 plan) internal returns (uint256 subId) {
        vm.prank(who);
        subId = manager.subscribe(plan, bytes32(0));
    }

    function _status(uint256 subId) internal view returns (SubscriptionManager.Status status) {
        (, , , , , , , status) = manager.subscriptions(subId);
    }

    function _credit(uint256 subId) internal view returns (uint256 credit) {
        (, , , , , credit, , ) = manager.subscriptions(subId);
    }

    /// @dev Warp to the next charge and charge as the keeper.
    function _chargeNext(uint256 subId) internal {
        (, , , uint64 next, , , , ) = manager.subscriptions(subId);
        vm.warp(next);
        vm.prank(keeper);
        manager.charge(subId);
    }

    function _handOver() internal {
        vm.prank(merchant);
        manager.transferOwnership(merchant, newOwner);
        vm.prank(newOwner);
        manager.acceptOwnership(merchant);
    }

    // ---- merchant accounts ----

    function testAccountOwnsItselfAndIsPaidByDefault() public view {
        assertEq(manager.ownerOf(merchant), merchant);
        assertEq(manager.payoutOf(merchant), merchant);
    }

    function testFixedPayoutReceivesTheMerchantShare() public {
        vm.prank(merchant);
        manager.setPayout(merchant, safe);
        _subscribe(alice, planId);
        assertEq(usdc.balanceOf(safe), PRICE - PRICE / 100);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function testZeroPayoutFollowsTheOwnerAgain() public {
        vm.startPrank(merchant);
        manager.setPayout(merchant, safe);
        manager.setPayout(merchant, address(0));
        vm.stopPrank();
        assertEq(manager.payoutOf(merchant), merchant);
    }

    function testPayoutCannotBeTheManager() public {
        // The share would be stuck there, and the manager holds nothing at rest.
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.BadPayout.selector);
        manager.setPayout(merchant, address(manager));
    }

    function testOnlyTheOwnerSetsPayout() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotOwner.selector);
        manager.setPayout(merchant, alice);
    }

    function testOwnershipMovesInTwoSteps() public {
        vm.prank(merchant);
        manager.transferOwnership(merchant, newOwner);
        assertEq(manager.ownerOf(merchant), merchant); // not until accepted
        assertEq(manager.pendingOwner(merchant), newOwner);

        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotPendingOwner.selector);
        manager.acceptOwnership(merchant);

        vm.expectEmit(true, true, true, true, address(manager));
        emit SubscriptionManager.OwnershipTransferred(merchant, merchant, newOwner);
        vm.prank(newOwner);
        manager.acceptOwnership(merchant);
        assertEq(manager.ownerOf(merchant), newOwner);
        assertEq(manager.pendingOwner(merchant), address(0));
    }

    function testOnlyTheOwnerStartsAHandover() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotOwner.selector);
        manager.transferOwnership(merchant, alice);
        assertEq(manager.pendingOwner(merchant), address(0));
    }

    function testNewOwnerActsForTheAccountAndTheOldKeyCannot() public {
        uint256 subId = _subscribe(alice, planId);
        _handOver();

        // The old key no longer creates plans under the account, although the
        // account is its own address.
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotOwner.selector);
        manager.createPlan(merchant, _terms(PRICE));
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotSubscriberOrMerchant.selector);
        manager.cancelSubscription(subId);

        // The new owner adds a plan that existing subscribers can switch to.
        vm.prank(newOwner);
        uint256 pro = manager.createPlan(merchant, _terms(PRICE * 2));
        vm.prank(alice);
        manager.changePlan(subId, pro);
        vm.prank(newOwner);
        manager.cancelSubscription(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.CANCELLED));
    }

    function testPayoutFollowsTheNewOwnerUnlessFixed() public {
        _handOver();
        assertEq(manager.payoutOf(merchant), newOwner);

        // A fixed payout survives a later handover.
        vm.startPrank(newOwner);
        manager.setPayout(merchant, safe);
        manager.transferOwnership(merchant, bob);
        vm.stopPrank();
        vm.prank(bob);
        manager.acceptOwnership(merchant);
        assertEq(manager.payoutOf(merchant), safe);
    }

    function testNobodyCreatesPlansForAnotherAccount() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotOwner.selector);
        manager.createPlan(merchant, _terms(PRICE));
    }

    function testBlocklistedPayoutRecoversByChangingIt() public {
        uint256 subId = _subscribe(alice, planId);
        usdc.setBlocked(merchant, true);
        (, , , uint64 due, , , , ) = manager.subscriptions(subId);
        vm.warp(due);
        // The push to a blocked address reverts the whole charge; no failure is recorded.
        vm.prank(keeper);
        vm.expectRevert(bytes("blocklisted"));
        manager.charge(subId);

        // Two cycles later the merchant sets a new payout. One cycle is
        // collected and a fresh one starts: the blocked cycles are lost.
        vm.warp(due + 2 * CYCLE);
        vm.prank(merchant);
        manager.setPayout(merchant, safe);
        vm.prank(keeper);
        manager.charge(subId);
        (, , , uint64 next, uint64 failed, , uint256 count, ) = manager.subscriptions(subId);
        assertEq(usdc.balanceOf(safe), PRICE - PRICE / 100);
        assertEq(count, 2);
        assertEq(failed, 0);
        assertEq(next, block.timestamp + CYCLE);
    }

    // ---- retiring plans ----

    function testRetiredPlanTakesNoNewSubscribers() public {
        vm.expectEmit(true, true, true, true, address(manager));
        emit SubscriptionManager.PlanRetired(planId, true);
        vm.prank(merchant);
        manager.setPlanRetired(planId, true);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.RetiredPlan.selector);
        manager.subscribe(planId, bytes32(0));
    }

    function testRetiredPlanKeepsBillingItsSubscribers() public {
        uint256 subId = _subscribe(alice, planId);
        vm.prank(merchant);
        manager.setPlanRetired(planId, true);
        _chargeNext(subId);
        (, , , , , , uint256 count, ) = manager.subscriptions(subId);
        assertEq(count, 2);
    }

    function testRetiredPlanRefusesChangesIntoItButNotOutOfIt() public {
        uint256 other = _plan(_terms(PRICE * 2));
        uint256 subId = _subscribe(alice, planId);
        vm.prank(merchant);
        manager.setPlanRetired(other, true);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.RetiredPlan.selector);
        manager.changePlan(subId, other);

        // Reversible; and a subscriber may leave a retired plan.
        vm.startPrank(merchant);
        manager.setPlanRetired(other, false);
        manager.setPlanRetired(planId, true);
        vm.stopPrank();
        vm.prank(alice);
        manager.changePlan(subId, other);
    }

    function testOnlyTheOwnerRetiresAKnownPlan() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotOwner.selector);
        manager.setPlanRetired(planId, true);
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.UnknownPlan.selector);
        manager.setPlanRetired(999, true);
    }

    // ---- cycle limits ----

    function testLimitedPlanCompletesAfterItsLastCycle() public {
        uint256 subId = _subscribe(alice, _limited(3));
        _chargeNext(subId);
        (, , , uint64 dueThird, , , , ) = manager.subscriptions(subId);
        vm.warp(dueThird);
        vm.expectEmit(true, true, true, true, address(manager));
        emit SubscriptionManager.Completed(subId);
        vm.prank(keeper);
        manager.charge(subId);

        (, , , uint64 paidThrough, , , uint256 count, SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.COMPLETED));
        assertEq(count, 3);
        assertEq(manager.planCycles(subId), 3);
        assertEq(paidThrough, dueThird + CYCLE); // the end of the last paid cycle

        vm.warp(paidThrough);
        assertFalse(manager.isChargeable(subId));
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
    }

    function testOneTimePaymentCompletesAtSubscribe() public {
        uint256 subId = _subscribe(alice, _limited(1));
        (, , , , , , uint256 count, SubscriptionManager.Status status) = manager.subscriptions(subId);
        assertEq(count, 1);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.COMPLETED));
        assertEq(usdc.balanceOf(merchant), PRICE - PRICE / 100);
    }

    function testCompletedIsTerminal() public {
        uint256 subId = _subscribe(alice, _limited(1));
        vm.startPrank(alice);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.pauseSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.cancelSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.resumeSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.changePlan(subId, planId);
        vm.stopPrank();
    }

    function testPlanChangeIntoAOneCyclePlanStaysCompleted() public {
        // changePlan ended by setting ACTIVE unconditionally, which would undo
        // the completion and let anyone's charge() take a second "one-time"
        // payment a cycle later (2026-10-25 design review, H2).
        uint256 subId = _subscribe(alice, planId);
        uint256 once = _limited(1);
        vm.prank(alice);
        manager.changePlan(subId, once);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.COMPLETED));

        uint256 before = usdc.balanceOf(alice);
        vm.warp(block.timestamp + CYCLE);
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
        assertEq(usdc.balanceOf(alice), before);
    }

    function testPlanChangeRestartsTheCycleCount() public {
        uint256 subId = _subscribe(alice, _limited(3));
        _chargeNext(subId);
        assertEq(manager.planCycles(subId), 2);
        uint256 otherThree = _limited(3);
        vm.prank(alice);
        manager.changePlan(subId, otherThree);
        assertEq(manager.planCycles(subId), 1); // the change's own charge
        _chargeNext(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.ACTIVE));
        _chargeNext(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.COMPLETED));
    }

    function testCyclesPaidFromCreditCountAndLeftoverCreditIsForfeited() public {
        // Pay $100, then move at once into a 3-cycle $10 plan: the credit pays
        // all three cycles, and the $70 left is forfeited at completion, as at
        // cancellation (a resolved issue in the design).
        uint256 pro = _plan(_terms(100_000_000));
        uint256 subId = _subscribe(alice, pro);
        uint256 three = _limited(3);
        vm.prank(alice);
        manager.changePlan(subId, three);
        _chargeNext(subId);
        _chargeNext(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.COMPLETED));
        assertEq(_credit(subId), 70_000_000);
        assertEq(usdc.balanceOf(alice), MINTED - 100_000_000); // nothing pulled after the first
    }

    // ---- intro pricing ----

    function testIntroPriceForTheFirstCycles() public {
        uint256 subId = _subscribe(alice, _intro(2));
        _chargeNext(subId);
        _chargeNext(subId);
        assertEq(usdc.balanceOf(alice), MINTED - (2 * INTRO + PRICE));
        assertEq(usdc.balanceOf(merchant), 2 * (INTRO - INTRO / 100) + (PRICE - PRICE / 100));
        assertEq(manager.introCyclesLeft(subId), 0);
        assertEq(manager.billedPrice(subId), PRICE);
    }

    function testIntroStartsAfterTheTrial() public {
        SubscriptionManager.PlanTerms memory t = basicTerms(PRICE, CYCLE, 7 days, 2);
        t.introPrice = INTRO;
        t.introCycles = 1;
        uint256 subId = _subscribe(alice, _plan(t));
        assertEq(usdc.balanceOf(alice), MINTED); // trial: nothing yet
        _chargeNext(subId);
        assertEq(usdc.balanceOf(alice), MINTED - INTRO);
        _chargeNext(subId);
        assertEq(usdc.balanceOf(alice), MINTED - INTRO - PRICE);
    }

    function testIntroPricesDoNotSurvivePlanHopping() public {
        uint256 promoA = _intro(3);
        uint256 promoB = _intro(3);
        uint256 subId = _subscribe(alice, promoA);
        assertEq(manager.billedPrice(subId), INTRO);
        vm.prank(alice);
        manager.changePlan(subId, promoB);
        assertEq(manager.introCyclesLeft(subId), 0);
        assertEq(manager.billedPrice(subId), PRICE);
        vm.prank(alice);
        manager.changePlan(subId, promoA);
        assertEq(manager.billedPrice(subId), PRICE);
    }

    function testCreditFromAnIntroCycleUsesTheIntroPrice() public {
        // A $1 intro cycle, switched at once: the credit is $1, not the $10 full
        // price the cycle never paid.
        uint256 promo = _intro(1);
        uint256 subId = _subscribe(alice, promo);
        uint256 five = _plan(_terms(5_000_000));
        vm.expectEmit(true, true, true, true, address(manager));
        emit SubscriptionManager.PlanChanged(subId, promo, five, INTRO);
        vm.prank(alice);
        manager.changePlan(subId, five);
        assertEq(usdc.balanceOf(alice), MINTED - INTRO - (5_000_000 - INTRO));
    }

    function testRoundTripsBetweenPlansAddNoCredit() public {
        // The billed price is written on cycles paid entirely from credit too.
        // Written only after a pull, every visit to the $10 plan would add
        // about $90 of credit nobody paid for (2026-10-25 design review, H1).
        uint256 pro = _plan(_terms(100_000_000));
        uint256 basic = _plan(_terms(10_000_000));
        uint256 subId = _subscribe(alice, pro);
        vm.startPrank(alice);
        for (uint256 i = 0; i < 3; i++) {
            manager.changePlan(subId, basic);
            manager.changePlan(subId, pro);
        }
        vm.stopPrank();
        uint256 paid = MINTED - usdc.balanceOf(alice);
        assertEq(paid, 100_000_000);
        assertLe(_credit(subId), paid);
    }

    function testIntroTermsAreChecked() public {
        SubscriptionManager.PlanTerms memory t = _terms(PRICE);
        t.introCycles = 1;
        vm.startPrank(merchant);
        t.introPrice = PRICE; // not a discount
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, t);
        t.introPrice = 0; // free time is what trials are for
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, t);
        t.introPrice = INTRO;
        t.introCycles = 0; // an intro price with no intro cycles
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, t);
        t.introCycles = 3;
        t.maxCycles = 2; // more intro cycles than the plan has
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(merchant, t);
        t.maxCycles = 3;
        manager.createPlan(merchant, t);
        vm.stopPrank();
    }

    // ---- moving a subscription to a new wallet ----

    function testTransferMovesTheSubscription() public {
        uint256 plan = _transferable(PRICE);
        vm.prank(alice);
        uint256 subId = manager.subscribe(plan, bytes32("cust-7"));
        (, , , uint64 nextBefore, , , uint256 countBefore, ) = manager.subscriptions(subId);

        vm.prank(alice);
        manager.proposeTransfer(subId, bob);
        assertEq(manager.pendingTransfer(subId), bob);
        vm.expectEmit(true, true, true, true, address(manager));
        emit SubscriptionManager.SubscriptionTransferred(subId, alice, bob);
        vm.prank(bob);
        manager.acceptTransfer(subId, plan);

        (address subscriber, , , uint64 next, , , uint256 count, ) = manager.subscriptions(subId);
        assertEq(subscriber, bob);
        assertEq(next, nextBefore);
        assertEq(count, countBefore);
        assertEq(manager.subscriptionRef(subId), bytes32("cust-7"));
        assertEq(manager.pendingTransfer(subId), address(0));

        // The next charge comes from bob's allowance, not alice's.
        _chargeNext(subId);
        assertEq(usdc.balanceOf(alice), MINTED - PRICE);
        assertEq(usdc.balanceOf(bob), MINTED - PRICE);
    }

    function testNobodyCanMakeAnotherWalletPay() public {
        // bob has a large allowance. Without bob's own acceptance, nobody can
        // point a subscription at it, the subscriber included.
        uint256 plan = _transferable(PRICE);
        uint256 subId = _subscribe(alice, plan);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotPendingSubscriber.selector);
        manager.acceptTransfer(subId, plan);
        vm.prank(alice);
        manager.proposeTransfer(subId, bob);
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.NotPendingSubscriber.selector);
        manager.acceptTransfer(subId, plan);
        (address subscriber, , , , , , , ) = manager.subscriptions(subId);
        assertEq(subscriber, alice);
    }

    function testOnlyTheSubscriberProposes() public {
        // A merchant path would let a stolen owner key hand subscriptions to itself.
        uint256 plan = _transferable(PRICE);
        uint256 subId = _subscribe(alice, plan);
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotSubscriber.selector);
        manager.proposeTransfer(subId, merchant);
    }

    function testWithdrawnProposalCannotBeAccepted() public {
        uint256 plan = _transferable(PRICE);
        uint256 subId = _subscribe(alice, plan);
        vm.startPrank(alice);
        manager.proposeTransfer(subId, bob);
        manager.proposeTransfer(subId, address(0));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotPendingSubscriber.selector);
        manager.acceptTransfer(subId, plan);
    }

    function testAcceptanceNamesThePlan() public {
        uint256 plan = _transferable(PRICE);
        uint256 pricier = _transferable(PRICE * 5);
        uint256 subId = _subscribe(alice, plan);
        vm.startPrank(alice);
        manager.proposeTransfer(subId, bob);
        manager.changePlan(subId, pricier); // after bob saw the proposal
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.PlanMismatch.selector);
        manager.acceptTransfer(subId, plan);
    }

    function testPlansWithoutTransfersRefuseThem() public {
        uint256 subId = _subscribe(alice, planId);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotTransferable.selector);
        manager.proposeTransfer(subId, bob);

        // A proposal made on a transferable plan does not survive a move to one
        // that refuses transfers.
        uint256 plan = _transferable(PRICE);
        uint256 other = _subscribe(alice, plan);
        vm.startPrank(alice);
        manager.proposeTransfer(other, bob);
        manager.changePlan(other, planId);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotTransferable.selector);
        manager.acceptTransfer(other, planId);
    }

    function testNoTransferOnceCancelled() public {
        uint256 plan = _transferable(PRICE);
        uint256 subId = _subscribe(alice, plan);
        vm.startPrank(alice);
        manager.proposeTransfer(subId, bob);
        manager.cancelSubscription(subId);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.acceptTransfer(subId, plan);
    }

    function testTransferKeepsTheDunningState() public {
        // A failing subscription moves with its failure count and the time of
        // its last failure, so the retry schedule carries on unchanged.
        address carol = makeAddr("carol");
        address dave = makeAddr("dave"); // no allowance either
        usdc.mint(carol, PRICE * 10);
        vm.prank(carol);
        usdc.approve(address(manager), PRICE); // one cycle: the next pull fails
        uint256 plan = _transferable(PRICE);
        uint256 subId = _subscribe(carol, plan);
        (, , , uint64 due, , , , ) = manager.subscriptions(subId);
        vm.warp(due);
        vm.prank(keeper);
        manager.charge(subId);
        uint64 failedAt = manager.lastFailedAt(subId);

        vm.prank(carol);
        manager.proposeTransfer(subId, dave);
        vm.prank(dave);
        manager.acceptTransfer(subId, plan);

        (, , , , uint64 failed, , , ) = manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(manager.lastFailedAt(subId), failedAt);
        vm.prank(keeper);
        vm.expectRevert(SubscriptionManager.RetryTooSoon.selector);
        manager.charge(subId);
    }
}

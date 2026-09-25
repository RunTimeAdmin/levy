// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {IPermit2} from "../src/IPermit2.sol";

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
        planId = manager.createPlan(PRICE, CYCLE, 0, 3 days, 2);

        usdc.mint(alice, 1_000_000_000); // $1,000
    }

    // ---- plan creation ----

    function testCreatePlan() public view {
        (
            address m,
            uint256 price,
            uint256 cycle,
            uint256 trial,
            ,
            uint8 maxFailed,
            bool exists
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
        manager.createPlan(0, CYCLE, 0, 3 days, 2);
    }

    function testCreatePlanRevertsOnTrialLongerThanCycle() public {
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(PRICE, CYCLE, CYCLE, 3 days, 2);
    }

    // ---- subscribe ----

    function testSubscribeNoTrial() public {
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        vm.prank(alice);
        uint256 subId = manager.subscribe(planId);
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

    function testSubscribeWithoutAllowanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.PaymentFailed.selector);
        manager.subscribe(planId);
    }

    function testSubscribeWithTrial() public {
        vm.prank(merchant);
        uint256 trialPlan = manager.createPlan(PRICE, CYCLE, 7 days, 3 days, 2);
        vm.prank(alice);
        uint256 subId = manager.subscribe(trialPlan);
        (, , uint64 start, uint64 nextCharge, , , uint256 chargeCount, SubscriptionManager.Status status) =
            manager.subscriptions(subId);
        assertEq(uint256(status), uint256(SubscriptionManager.Status.TRIAL));
        assertEq(nextCharge, start + 7 days);
        assertEq(chargeCount, 0); // trial: nothing pulled, no allowance needed
    }

    function testSubscribeUnknownPlanReverts() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.UnknownPlan.selector);
        manager.subscribe(999);
    }

    // ---- charge ----

    /// @dev Approves 12 cycles, then subscribes (which pays the first cycle).
    function _subscribeAndApprove() internal returns (uint256 subId) {
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        vm.prank(alice);
        subId = manager.subscribe(planId);
    }

    /// @dev Approves exactly one cycle, so every pull after subscribe fails.
    function _subscribeOneCycleOnly() internal returns (uint256 subId) {
        vm.prank(alice);
        usdc.approve(address(manager), PRICE);
        vm.prank(alice);
        subId = manager.subscribe(planId);
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
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);

        vm.prank(keeper);
        manager.charge(subId);
        assertEq(usdc.balanceOf(merchant), 2 * (PRICE - PRICE / 100));
    }

    function testChargeFailurePreservesCredit() public {
        // Alice downgrades from $10 to $8 three days into a paid cycle:
        // $9 unused credit, $8 of it pays the new plan's first cycle, $1 is
        // left over. Her allowance then lapses; the $7 pull fails and the $1
        // credit must survive.
        vm.prank(merchant);
        uint256 eightDollarPlan = manager.createPlan(8_000_000, CYCLE, 0, 3 days, 10);
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

    // ---- proration ----

    function testChangePlanProrates() public {
        uint256 subId = _subscribeAndApprove(); // paid $10 for cycle 1
        vm.prank(merchant);
        uint256 priceyPlan = manager.createPlan(PRICE * 2, CYCLE, 0, 3 days, 2);

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
        uint256 twoDollarPlan = manager.createPlan(2_000_000, CYCLE, 0, 3 days, 2);
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
        uint256 trialPlan = manager.createPlan(PRICE, CYCLE, 7 days, 3 days, 2);
        vm.prank(alice);
        usdc.approve(address(manager), PRICE * 12);
        vm.prank(alice);
        uint256 subId = manager.subscribe(trialPlan);

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
        uint256 priceyPlan = manager.createPlan(PRICE * 2, CYCLE, 0, 3 days, 2);
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
        uint256 bobPlan = manager.createPlan(PRICE, CYCLE, 0, 3 days, 2);
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
        uint256 selfPlan = manager.createPlan(1e30, CYCLE, 0, 0, 1);
        vm.expectRevert(SubscriptionManager.PaymentFailed.selector);
        manager.subscribe(selfPlan); // the 1e30 is now owed up front

        // Even a genuinely paid self-plan cannot move credit to another merchant.
        uint256 cheapSelfPlan = manager.createPlan(PRICE, CYCLE, 0, 0, 1);
        usdc.mint(attacker, PRICE);
        usdc.approve(address(manager), PRICE);
        uint256 subId = manager.subscribe(cheapSelfPlan);
        vm.expectRevert(SubscriptionManager.DifferentMerchant.selector);
        manager.changePlan(subId, planId);
        vm.stopPrank();
    }

    function testPlanHoppingStillPaysEveryCycle() public {
        // Old exploit: hop plans a second before each charge so nextChargeAt
        // keeps moving and nothing is ever pulled.
        vm.prank(merchant);
        uint256 otherPlan = manager.createPlan(PRICE, CYCLE, 0, 3 days, 2);
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

    // ---- fee math ----

    function testFeeRoundsDown() public {
        // $1.50 pull -> fee $0.015 -> 1500 units exactly; $1.51 -> 1510.
        // Dust case: price 199 units -> fee 1 (199/100), merchant keeps 198.
        vm.prank(merchant);
        uint256 dustPlan = manager.createPlan(199, CYCLE, 0, 3 days, 2);
        vm.prank(alice);
        usdc.approve(address(manager), 199 * 12);
        vm.prank(alice);
        uint256 subId = manager.subscribe(dustPlan); // cycle 1
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

    function testFeeRouterOnlyTreasurySetsTreasury() public {
        vm.prank(bob);
        vm.expectRevert(FeeRouter.OnlyTreasury.selector);
        router.setTreasury(bob);
        vm.prank(treasury);
        router.setTreasury(bob);
        assertEq(router.treasury(), bob);
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
        // Arc mainnet/testnet Permit2; NOT the Ethereum canonical address.
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
        uint256 subId = manager.subscribeWithPermit2(planId, p, sig);

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
        assertEq(permit2.allowance(s, address(usdc), address(manager)), PRICE * 12 - 2 * PRICE);
    }

    function testSubscribeWithPermit2OnlySignerCanSubmit() public {
        // A relayer holding s's signed permit could otherwise subscribe s to a
        // plan of the relayer's choosing and pull the first cycle at once.
        address s = _signer();
        vm.prank(s);
        usdc.approve(address(permit2), type(uint256).max);
        vm.prank(keeper);
        uint256 keeperPlan = manager.createPlan(PRICE * 12, CYCLE, 0, 0, 1);

        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(
            s,
            address(usdc),
            uint160(PRICE * 12),
            address(manager),
            block.timestamp + 1 hours
        );
        vm.prank(keeper);
        vm.expectRevert(MockPermit2.BadSignature.selector); // checked against msg.sender
        manager.subscribeWithPermit2(keeperPlan, p, sig);
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
        manager.subscribeWithPermit2(planId, p, sig);
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
        manager.subscribeWithPermit2(planId, p, sig);
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
        manager.subscribeWithPermit2(planId, p, badSig);
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
        uint256 subId = manager.subscribeWithPermit2(planId, p, sig);

        (, , , uint64 nextCharge, , , , ) = manager.subscriptions(subId);
        vm.warp(nextCharge);
        vm.prank(keeper);
        manager.charge(subId);

        // Direct allowance paid both cycles (subscribe + charge), Permit2 untouched.
        assertEq(usdc.allowance(s, address(manager)), PRICE * 12 - 2 * PRICE);
        assertEq(permit2.allowance(s, address(usdc), address(manager)), PRICE * 12);
    }
}

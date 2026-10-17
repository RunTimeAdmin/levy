// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {IPermit2} from "../src/IPermit2.sol";

/// @notice Test-only token whose transferFrom returns false instead of
///         reverting when the allowance or balance is short, like some
///         pre-OpenZeppelin ERC-20s. Exercises the `ok == false` branch of
///         _tryPull, which MockUSDC (it reverts) never reaches.
contract FalseReturnUSDC is ERC20 {
    constructor() ERC20("False USD", "FUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (allowance(from, msg.sender) < value || balanceOf(from) < value) return false;
        return super.transferFrom(from, to, value);
    }
}

/// @notice Fee math and charge paths the audit relies on: the 99/1 split for
///         any amount, credit use, every _tryPull outcome, and the guards on
///         charge, changePlan and the lifecycle calls.
contract ChargePathsTest is Test {
    MockUSDC usdc;
    FeeRouter router;
    SubscriptionManager manager;
    MockPermit2 permit2;

    address merchant = makeAddr("merchant");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");

    uint256 constant PRICE = 10_000_000; // $10.00
    uint256 constant CYCLE = 30 days;
    uint256 planId;

    function setUp() public {
        usdc = new MockUSDC();
        router = new FeeRouter(address(usdc), treasury);
        permit2 = new MockPermit2();
        manager = new SubscriptionManager(address(usdc), address(router), address(permit2));

        vm.prank(merchant);
        planId = manager.createPlan(PRICE, CYCLE, 0, 3 days, 2);
    }

    function _plan(uint256 price, uint256 trial) internal returns (uint256 id) {
        vm.prank(merchant);
        id = manager.createPlan(price, CYCLE, trial, 0, 2);
    }

    function _subscribe(address who, uint256 id, uint256 allowance) internal returns (uint256 subId) {
        vm.prank(who);
        usdc.approve(address(manager), allowance);
        vm.prank(who);
        subId = manager.subscribe(id, bytes32(0));
    }

    function _next(uint256 subId) internal view returns (uint64 t) {
        (, , , t, , , , ) = manager.subscriptions(subId);
    }

    function _status(uint256 subId) internal view returns (SubscriptionManager.Status s) {
        (, , , , , , , s) = manager.subscriptions(subId);
    }

    function _credit(uint256 subId) internal view returns (uint256 c) {
        (, , , , , c, , ) = manager.subscriptions(subId);
    }

    // ---- fee math ----

    /// @dev For any price, one pull splits exactly: the fee is due / 100
    ///      rounded down, the merchant gets the rest, and nothing stays in
    ///      the manager.
    function testFuzz_FeeSplitIsExactAndConserved(uint256 price) public {
        price = bound(price, 1, type(uint128).max);
        uint256 id = _plan(price, 0);
        usdc.mint(alice, price);

        uint256 expectedFee = price / 100;
        vm.prank(alice);
        usdc.approve(address(manager), price);
        vm.expectEmit(true, true, false, true, address(manager));
        emit SubscriptionManager.Charged(1, price, expectedFee, keccak256(abi.encode(uint256(1), uint256(1))), 1);
        vm.prank(alice);
        manager.subscribe(id, bytes32(0));

        assertEq(usdc.balanceOf(address(router)), expectedFee);
        assertEq(usdc.balanceOf(merchant), price - expectedFee);
        assertEq(usdc.balanceOf(merchant) + usdc.balanceOf(address(router)), price);
        assertEq(usdc.balanceOf(address(manager)), 0);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function testFeeBoundaries() public {
        // due -> fee: below 100 units the whole pull goes to the merchant.
        uint256[6] memory dues = [uint256(1), 99, 100, 101, 199, 200];
        uint256[6] memory fees = [uint256(0), 0, 1, 1, 1, 2];
        for (uint256 i = 0; i < dues.length; i++) {
            uint256 id = _plan(dues[i], 0);
            usdc.mint(alice, dues[i]);
            uint256 routerBefore = usdc.balanceOf(address(router));
            uint256 merchantBefore = usdc.balanceOf(merchant);
            _subscribe(alice, id, dues[i]);
            assertEq(usdc.balanceOf(address(router)) - routerBefore, fees[i], "fee");
            assertEq(usdc.balanceOf(merchant) - merchantBefore, dues[i] - fees[i], "merchant share");
        }
    }

    function testFeeAtTheLargestPermit2Amount() public {
        // The largest pull Permit2 can carry: the split still has no overflow or loss.
        uint256 price = type(uint160).max;
        uint256 id = _plan(price, 0);
        usdc.mint(alice, price);
        _subscribe(alice, id, price);
        assertEq(usdc.balanceOf(address(router)), price / 100);
        assertEq(usdc.balanceOf(merchant), price - price / 100);
    }

    /// @dev Credit is spent before pulling; the fee is charged only on what
    ///      is pulled, never on the credited part.
    function testFuzz_PartialCreditFeeOnlyOnPulledAmount(uint256 elapsed) public {
        // Subscribe to a $30 plan, downgrade to $10 part-way through: the
        // unused share of the $30 cycle becomes credit.
        uint256 big = _plan(3 * PRICE, 0);
        usdc.mint(alice, 1_000 * PRICE);
        uint256 subId = _subscribe(alice, big, type(uint256).max);
        elapsed = bound(elapsed, 1, CYCLE - 1);
        vm.warp(block.timestamp + elapsed);

        uint256 credit = (3 * PRICE * (CYCLE - elapsed)) / CYCLE;
        uint256 routerBefore = usdc.balanceOf(address(router));
        uint256 merchantBefore = usdc.balanceOf(merchant);
        vm.prank(alice);
        manager.changePlan(subId, planId);

        uint256 due = credit >= PRICE ? 0 : PRICE - credit;
        uint256 left = credit >= PRICE ? credit - PRICE : 0;
        assertEq(usdc.balanceOf(address(router)) - routerBefore, due / 100, "fee");
        assertEq(usdc.balanceOf(merchant) - merchantBefore, due - due / 100, "merchant");
        assertEq(_credit(subId), left, "credit carried");
        assertEq(usdc.balanceOf(address(manager)), 0);
    }

    function testCreditCoveredCycleEmitsZeroAmountCharge() public {
        uint256 big = _plan(3 * PRICE, 0);
        usdc.mint(alice, 1_000 * PRICE);
        uint256 subId = _subscribe(alice, big, type(uint256).max);
        // Downgrade at once: almost the whole $30 is credit, covering $10 now.
        vm.prank(alice);
        manager.changePlan(subId, planId);
        uint256 creditAfterChange = _credit(subId);
        assertEq(creditAfterChange, 2 * PRICE);

        // The next cycle is paid from credit: Charged(amount 0, fee 0), no movement.
        vm.warp(_next(subId));
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(manager));
        emit SubscriptionManager.Charged(subId, 0, 0, keccak256(abi.encode(subId, uint256(3))), 3);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(_credit(subId), PRICE);
    }

    function testCreditExactlyEqualToPriceIsFullyUsed() public {
        // Credit == price takes the credit branch (>=), leaving zero and pulling nothing.
        uint256 big = _plan(2 * PRICE, 0);
        usdc.mint(alice, 1_000 * PRICE);
        uint256 subId = _subscribe(alice, big, type(uint256).max);
        vm.warp(block.timestamp + CYCLE / 2); // half of $20 unused = $10 credit
        uint256 aliceBefore = usdc.balanceOf(alice);
        // Not even a zero-amount pull or payout.
        vm.expectCall(address(usdc), abi.encodeWithSelector(usdc.transferFrom.selector), 0);
        vm.expectCall(address(usdc), abi.encodeWithSelector(usdc.transfer.selector), 0);
        vm.prank(alice);
        manager.changePlan(subId, planId);
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(_credit(subId), 0);
    }

    function testInvoiceRefIsSubIdAndChargeCount() public {
        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        vm.warp(_next(subId));
        vm.expectEmit(true, true, false, true, address(manager));
        emit SubscriptionManager.Charged(subId, PRICE, PRICE / 100, keccak256(abi.encode(subId, uint256(2))), 2);
        vm.prank(keeper);
        manager.charge(subId);
    }

    // ---- _tryPull ----

    function testPullFallsBackToPermit2WhenTokenReturnsFalse() public {
        FalseReturnUSDC token = new FalseReturnUSDC();
        SubscriptionManager m = new SubscriptionManager(address(token), address(router), address(permit2));
        vm.prank(merchant);
        uint256 id = m.createPlan(PRICE, CYCLE, 0, 0, 2);

        address s = vm.addr(0xB0B5);
        token.mint(s, 100 * PRICE);
        vm.prank(s);
        token.approve(address(permit2), type(uint256).max);
        // No direct allowance to the manager: its transferFrom returns false.
        // Give the manager a Permit2 allowance by signing a permit.
        IPermit2.PermitSingle memory p = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: address(token),
                amount: uint160(12 * PRICE),
                expiration: uint48(block.timestamp + 365 days),
                nonce: 0
            }),
            spender: address(m),
            sigDeadline: block.timestamp + 1 hours
        });
        bytes memory sig = _signPermit(0xB0B5, p);
        vm.prank(s);
        uint256 subId = m.subscribeWithPermit2(id, bytes32(0), p, sig);

        (, , , , , , uint256 chargeCount, ) = m.subscriptions(subId);
        assertEq(chargeCount, 1);
        assertEq(permit2.allowance(s, address(token), address(m)), 11 * PRICE);
        assertEq(token.balanceOf(merchant), PRICE - PRICE / 100);
    }

    function testPullFailsWhenTokenReturnsFalseAndNoPermit2() public {
        FalseReturnUSDC token = new FalseReturnUSDC();
        SubscriptionManager m = new SubscriptionManager(address(token), address(router), address(permit2));
        vm.prank(merchant);
        uint256 id = m.createPlan(PRICE, CYCLE, 0, 0, 2);
        token.mint(alice, 100 * PRICE);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.PaymentFailed.selector);
        m.subscribe(id, bytes32(0));
    }

    function testPullAboveUint160SkipsPermit2() public {
        // A price over uint160 can never go through Permit2; the pull fails
        // without calling it, and charge records a failure instead of reverting.
        uint256 huge = uint256(type(uint160).max) + 1;
        uint256 id = _plan(huge, 7 days);
        vm.prank(alice);
        uint256 subId = manager.subscribe(id, bytes32(0)); // trial: nothing pulled yet
        vm.warp(_next(subId));
        vm.expectCall(address(permit2), abi.encodeWithSelector(IPermit2.transferFrom.selector), 0);
        vm.expectEmit(true, false, false, true, address(manager));
        emit SubscriptionManager.ChargeFailed(subId, 1);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.TRIAL));
    }

    function testPullAtUint160MaxStillTriesPermit2() public {
        uint256 id = _plan(type(uint160).max, 7 days);
        vm.prank(alice);
        uint256 subId = manager.subscribe(id, bytes32(0));
        vm.warp(_next(subId));
        vm.expectCall(
            address(permit2),
            abi.encodeCall(IPermit2.transferFrom, (alice, address(manager), type(uint160).max, address(usdc))),
            1
        );
        vm.prank(keeper);
        manager.charge(subId); // fails (no allowance anywhere) but Permit2 was asked
    }

    function testPullFailsOnBalanceShortfallWithAllowance() public {
        // Allowance is not enough: a subscriber who spent their balance fails
        // the pull, and nothing moves.
        usdc.mint(alice, PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        assertEq(usdc.balanceOf(alice), 0);
        vm.warp(_next(subId));
        uint256 merchantBefore = usdc.balanceOf(merchant);
        vm.prank(keeper);
        manager.charge(subId);
        (, , , uint64 nextAfter, uint64 failed, , uint256 chargeCount, ) = manager.subscriptions(subId);
        assertEq(failed, 1);
        assertEq(chargeCount, 1);
        assertEq(nextAfter, _next(subId)); // schedule does not advance on failure
        assertEq(usdc.balanceOf(merchant), merchantBefore);
    }

    function testTopUpAfterFailedPullsRecoversToActive() public {
        // maxFailed 2: two failures make it PAST_DUE; a later success clears
        // the count and returns it to ACTIVE on the original schedule.
        usdc.mint(alice, PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        uint64 due = _next(subId);
        vm.warp(due);
        vm.prank(keeper);
        manager.charge(subId);
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.PAST_DUE));

        usdc.mint(alice, PRICE);
        vm.prank(keeper);
        manager.charge(subId);
        (, , , uint64 nextAfter, uint64 failed, , , SubscriptionManager.Status st) = manager.subscriptions(subId);
        assertEq(failed, 0);
        assertEq(uint256(st), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(nextAfter, due + CYCLE);
    }

    function testTrialFirstChargeMovesToActive() public {
        uint256 id = _plan(PRICE, 7 days);
        usdc.mint(alice, PRICE);
        uint256 subId = _subscribe(alice, id, PRICE);
        uint64 trialEnd = _next(subId);
        vm.warp(trialEnd);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(_next(subId), trialEnd + CYCLE);
    }

    function testMaxFailedOneGoesPastDueThenPausesNextDay() public {
        vm.prank(merchant);
        uint256 id = manager.createPlan(PRICE, CYCLE, 0, 0, 1);
        usdc.mint(alice, PRICE);
        uint256 subId = _subscribe(alice, id, type(uint256).max);
        vm.warp(_next(subId));
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.PAST_DUE));
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, false, false, false, address(manager));
        emit SubscriptionManager.AutoPaused(subId);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.PAUSED));
    }

    // ---- guards ----

    function testChargeUnknownSubscriptionReverts() public {
        vm.expectRevert(SubscriptionManager.UnknownSubscription.selector);
        manager.charge(42);
    }

    function testChargePausedOrCancelledReverts() public {
        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        vm.warp(_next(subId));
        vm.prank(alice);
        manager.pauseSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
        assertFalse(manager.isChargeable(subId));

        vm.prank(alice);
        manager.cancelSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
        assertFalse(manager.isChargeable(subId));
    }

    function testChargeAtExactlyNextChargeAt() public {
        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        uint64 due = _next(subId);
        vm.warp(due - 1);
        assertFalse(manager.isChargeable(subId));
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.charge(subId);
        vm.warp(due);
        assertTrue(manager.isChargeable(subId));
        manager.charge(subId);
    }

    function testIsChargeableUnknownIsFalse() public view {
        assertFalse(manager.isChargeable(0));
        assertFalse(manager.isChargeable(999));
    }

    function testLifecycleCallsOnUnknownSubscriptionRevert() public {
        vm.expectRevert(SubscriptionManager.UnknownSubscription.selector);
        manager.pauseSubscription(7);
        vm.expectRevert(SubscriptionManager.UnknownSubscription.selector);
        manager.resumeSubscription(7);
        vm.expectRevert(SubscriptionManager.UnknownSubscription.selector);
        manager.cancelSubscription(7);
    }

    function testLifecycleStateGuards() public {
        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        vm.startPrank(alice);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.resumeSubscription(subId); // not paused
        manager.pauseSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.pauseSubscription(subId); // already paused
        manager.cancelSubscription(subId); // a paused sub can be cancelled
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.cancelSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.pauseSubscription(subId);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.resumeSubscription(subId);
        vm.stopPrank();
    }

    function testMerchantCanResumeAndCancel() public {
        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        vm.startPrank(merchant);
        manager.pauseSubscription(subId);
        manager.resumeSubscription(subId);
        manager.cancelSubscription(subId);
        vm.stopPrank();
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.CANCELLED));
    }

    function testStrangerCannotPauseOrResume() public {
        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotSubscriberOrMerchant.selector);
        manager.pauseSubscription(subId);
        vm.prank(alice);
        manager.pauseSubscription(subId);
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotSubscriberOrMerchant.selector);
        manager.resumeSubscription(subId);
    }

    function testChangePlanGuards() public {
        uint256 other = _plan(2 * PRICE, 0);
        vm.expectRevert(SubscriptionManager.UnknownSubscription.selector);
        manager.changePlan(5, other);

        usdc.mint(alice, 100 * PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);

        // Only the subscriber, not the merchant or anyone else.
        vm.prank(merchant);
        vm.expectRevert(SubscriptionManager.NotSubscriber.selector);
        manager.changePlan(subId, other);
        vm.prank(bob);
        vm.expectRevert(SubscriptionManager.NotSubscriber.selector);
        manager.changePlan(subId, other);

        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.UnknownPlan.selector);
        manager.changePlan(subId, 999);

        vm.prank(alice);
        manager.pauseSubscription(subId);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.changePlan(subId, other);

        vm.prank(alice);
        manager.cancelSubscription(subId);
        vm.prank(alice);
        vm.expectRevert(SubscriptionManager.NotChargeable.selector);
        manager.changePlan(subId, other);
    }

    function testChangePlanFromPastDueClearsFailuresAndGivesNoCredit() public {
        usdc.mint(alice, PRICE);
        uint256 subId = _subscribe(alice, planId, type(uint256).max);
        vm.warp(_next(subId));
        vm.prank(keeper);
        manager.charge(subId);
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        manager.charge(subId);
        assertEq(uint256(_status(subId)), uint256(SubscriptionManager.Status.PAST_DUE));

        // The overdue cycle was never paid, so there is no unused time to credit.
        uint256 other = _plan(2 * PRICE, 0);
        usdc.mint(alice, 2 * PRICE);
        vm.prank(alice);
        manager.changePlan(subId, other);
        (, , , uint64 nextAfter, uint64 failed, uint256 credit, , SubscriptionManager.Status st) =
            manager.subscriptions(subId);
        assertEq(credit, 0);
        assertEq(failed, 0);
        assertEq(uint256(st), uint256(SubscriptionManager.Status.ACTIVE));
        assertEq(nextAfter, block.timestamp + CYCLE);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function testCreatePlanBounds() public {
        vm.startPrank(merchant);
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(PRICE, 365 days * 10 + 1, 0, 0, 2);
        manager.createPlan(PRICE, 365 days * 10, 0, 0, 2);
        vm.expectRevert(SubscriptionManager.BadPlanParams.selector);
        manager.createPlan(PRICE, CYCLE, 0, 0, 0);
        manager.createPlan(PRICE, CYCLE, CYCLE - 1, 0, 255);
        vm.stopPrank();
    }

    // ---- constructors ----

    function testManagerConstructorRejectsZeroAddresses() public {
        vm.expectRevert(SubscriptionManager.ZeroAddress.selector);
        new SubscriptionManager(address(0), address(router), address(permit2));
        vm.expectRevert(SubscriptionManager.ZeroAddress.selector);
        new SubscriptionManager(address(usdc), address(0), address(permit2));
        vm.expectRevert(SubscriptionManager.ZeroAddress.selector);
        new SubscriptionManager(address(usdc), address(router), address(0));
    }

    function testFeeRouterConstructorRejectsZeroAddresses() public {
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        new FeeRouter(address(0), treasury);
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        new FeeRouter(address(usdc), address(0));
    }

    function testFeeRouterRejectsZeroTreasury() public {
        vm.prank(treasury);
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        router.setTreasury(address(0));
    }

    function testFeeRouterSweepGoesToNewTreasury() public {
        usdc.mint(address(router), 123);
        vm.expectEmit(true, true, false, true, address(router));
        emit FeeRouter.TreasuryUpdated(treasury, bob);
        vm.prank(treasury);
        router.setTreasury(bob);
        vm.expectEmit(true, false, false, true, address(router));
        emit FeeRouter.Swept(123, bob);
        router.sweep();
        assertEq(usdc.balanceOf(bob), 123);
        assertEq(usdc.balanceOf(treasury), 0);
        // The old treasury has lost control.
        vm.prank(treasury);
        vm.expectRevert(FeeRouter.OnlyTreasury.selector);
        router.setTreasury(treasury);
    }

    function testFeeRouterSweepWithNothingIsHarmless() public {
        vm.expectEmit(true, false, false, true, address(router));
        emit FeeRouter.Swept(0, treasury);
        router.sweep();
    }

    // ---- helpers ----

    function _signPermit(uint256 key, IPermit2.PermitSingle memory p) internal view returns (bytes memory) {
        bytes32 detailsHash = keccak256(
            abi.encode(
                keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"),
                p.details.token,
                p.details.amount,
                p.details.expiration,
                p.details.nonce
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
                        p.spender,
                        p.sigDeadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

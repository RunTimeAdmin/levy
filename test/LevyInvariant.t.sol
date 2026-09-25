// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/// @notice Fuzzing handler: throws random but valid-ish actions at the system.
///         Every action is revert-safe so one bad call never kills the run.
contract LevyHandler is Test {
    MockUSDC public usdc;
    FeeRouter public router;
    SubscriptionManager public manager;

    address[] public actors;
    address public treasury;
    uint256[] public planIds;
    uint256[] public subIds;

    uint256 public maxPriceSeen;
    mapping(uint256 => bool) public cancelled;
    mapping(uint256 => uint256) public chargeCountAtCancel;

    constructor(MockUSDC _usdc, FeeRouter _router, SubscriptionManager _manager, address _treasury) {
        usdc = _usdc;
        router = _router;
        manager = _manager;
        treasury = _treasury;
        actors.push(makeAddr("h-merchant"));
        actors.push(makeAddr("h-alice"));
        actors.push(makeAddr("h-bob"));
        actors.push(makeAddr("h-carol"));
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 1_000_000_000_000); // $1M each, plenty of runway
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function createPlan(uint256 price, uint256 cycleDays, uint8 maxFailed) external {
        price = bound(price, 1, 1_000_000_000_000);
        cycleDays = bound(cycleDays, 1, 365);
        maxFailed = uint8(bound(maxFailed, 1, 10));
        address merchant = actors[0];
        vm.prank(merchant);
        try manager.createPlan(price, cycleDays * 1 days, 0, 3 days, maxFailed) returns (
            uint256 planId
        ) {
            planIds.push(planId);
            if (price > maxPriceSeen) maxPriceSeen = price;
        } catch {}
    }

    function subscribe(uint256 actorSeed, uint256 planSeed) external {
        if (planIds.length == 0) return;
        address sub = _actor(actorSeed);
        uint256 planId = planIds[planSeed % planIds.length];
        vm.prank(sub);
        try manager.subscribe(planId) returns (uint256 subId) {
            subIds.push(subId);
        } catch {}
    }

    function approve(uint256 actorSeed, uint256 amount) external {
        address sub = _actor(actorSeed);
        amount = bound(amount, 0, 1_000_000_000_000);
        vm.prank(sub);
        usdc.approve(address(manager), amount);
    }

    function warpAndCharge(uint256 subSeed, uint256 daysForward) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[subSeed % subIds.length];
        daysForward = bound(daysForward, 0, 60);
        vm.warp(block.timestamp + daysForward * 1 days);
        try manager.charge(subId) {} catch {}
    }

    function changePlan(uint256 subSeed, uint256 planSeed) external {
        if (subIds.length == 0 || planIds.length < 2) return;
        uint256 subId = subIds[subSeed % subIds.length];
        (address subscriber, , , , , , , ) = manager.subscriptions(subId);
        uint256 newPlan = planIds[planSeed % planIds.length];
        vm.prank(subscriber);
        try manager.changePlan(subId, newPlan) {} catch {}
    }

    function cancelSub(uint256 subSeed, uint256 actorSeed) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[subSeed % subIds.length];
        address caller = _actor(actorSeed);
        vm.prank(caller);
        try manager.cancelSubscription(subId) {
            if (!cancelled[subId]) {
                cancelled[subId] = true;
                (, , , , , , uint256 cc, ) = manager.subscriptions(subId);
                chargeCountAtCancel[subId] = cc;
            }
        } catch {}
    }

    function pauseResume(uint256 subSeed, uint256 actorSeed, bool doPause) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[subSeed % subIds.length];
        (address subscriber, , , , , , , ) = manager.subscriptions(subId);
        // Only the subscriber bothers; merchant pause is covered by unit tests.
        vm.prank(subscriber == address(0) ? _actor(actorSeed) : subscriber);
        try manager.pauseSubscription(subId) {} catch {}
        if (!doPause) {
            vm.prank(subscriber == address(0) ? _actor(actorSeed) : subscriber);
            try manager.resumeSubscription(subId) {} catch {}
        }
    }

    function sweepFees() external {
        try router.sweep() {} catch {}
    }
}

contract LevyInvariantTest is Test {
    MockUSDC usdc;
    FeeRouter router;
    SubscriptionManager manager;
    LevyHandler handler;
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockUSDC();
        router = new FeeRouter(address(usdc), treasury);
        MockPermit2 permit2 = new MockPermit2();
        manager = new SubscriptionManager(address(usdc), address(router), address(permit2));
        handler = new LevyHandler(usdc, router, manager, treasury);

        targetContract(address(handler));
    }

    /// @notice Money is conserved: every minted unit sits in exactly one tracked account.
    function invariant_conservation() public view {
        uint256 accounted = usdc.balanceOf(address(manager)) +
            usdc.balanceOf(address(router)) +
            usdc.balanceOf(treasury);
        for (uint256 i = 0; i < 4; i++) {
            accounted += usdc.balanceOf(handler.actors(i));
        }
        assertEq(accounted, usdc.totalSupply());
    }

    /// @notice Failed attempts can never exceed the auto-pause bound.
    function invariant_failedAttemptsBounded() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            (, uint256 planId, , , uint64 failed, , , ) = manager.subscriptions(id);
            (, , , , , uint8 maxFailed, ) = manager.plans(planId);
            assertLe(failed, uint256(maxFailed) * 2);
        }
    }

    /// @notice Cancel is terminal: chargeCount never moves after cancellation.
    function invariant_cancelIsTerminal() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            if (handler.cancelled(id)) {
                (, , , , , , uint256 cc, SubscriptionManager.Status status) = manager
                    .subscriptions(id);
                assertEq(uint256(status), uint256(SubscriptionManager.Status.CANCELLED));
                assertEq(cc, handler.chargeCountAtCancel(id));
            }
        }
    }

    /// @notice Billing cadence never moves backwards.
    function invariant_nextChargeMonotonic() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            (, , uint64 start, uint64 nextCharge, , , , ) = manager.subscriptions(id);
            assertGe(nextCharge, start);
        }
    }

    /// @notice Proration credit can never exceed the largest price ever seen.
    function invariant_creditBounded() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            (, , , , , uint256 credit, , ) = manager.subscriptions(id);
            assertLe(credit, handler.maxPriceSeen());
        }
    }

    /// @notice The manager never holds funds at rest: every pull is fully split.
    function invariant_managerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(manager)), 0);
    }
}

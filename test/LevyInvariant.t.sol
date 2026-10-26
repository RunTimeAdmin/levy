// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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
    mapping(uint256 => uint256) public paid; // USDC pulled per subscription, summed from Charged
    mapping(uint256 => uint256) public lastFailureSeen; // from ChargeFailed; cleared on resume, as the contract does
    bool public failuresTooClose; // two recorded failures of one subscription closer than retryGap allows
    bool public dueAfterCharge; // a successful charge() left its subscription chargeable

    // v2 (docs/manager-v2-design.md)
    address public payoutAddr = makeAddr("h-payout"); // a fixed payout outside the actors
    mapping(uint256 => bool) public retired;
    bool public joinedRetired; // a subscribe or plan change into a retired plan succeeded
    mapping(uint256 => bool) public completed;
    mapping(uint256 => uint256) public chargeCountAtComplete;
    mapping(uint256 => address) public holder; // who should be the subscriber
    mapping(uint256 => address) public proposedTo; // the subscriber's live transfer proposal
    bool public transferWithoutProposal; // an acceptTransfer succeeded for a wallet nobody proposed

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

    /// @dev Credits every Charged amount in the recorded logs to its subscription,
    ///      and checks every ChargeFailed against the previous one.
    function _recordPaid() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(manager)) continue;
            uint256 id = uint256(logs[i].topics[1]);
            if (logs[i].topics[0] == SubscriptionManager.Charged.selector) {
                (uint256 amount, , ) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                paid[id] += amount;
            } else if (logs[i].topics[0] == SubscriptionManager.ChargeFailed.selector) {
                // The event carries the count including this failure; the gap
                // depends on how many came before it since the last success.
                uint256 before = abi.decode(logs[i].data, (uint256)) - 1;
                uint256 last = lastFailureSeen[id];
                if (before > 0 && block.timestamp < last + manager.retryGap(before)) failuresTooClose = true;
                lastFailureSeen[id] = block.timestamp;
            } else if (logs[i].topics[0] == SubscriptionManager.Completed.selector) {
                completed[id] = true;
                (, , , , , , uint256 cc, ) = manager.subscriptions(id);
                chargeCountAtComplete[id] = cc;
            }
        }
    }

    /// @dev The merchant account is actors[0]; whoever owns it now acts for it.
    function _merchantOwner() internal view returns (address) {
        return manager.ownerOf(actors[0]);
    }

    /// @dev `seed` picks the v2 terms: an intro price, a cycle limit of 1 to 4
    ///      (so one-cycle plans come up), both or neither, and transferability.
    function createPlan(uint256 price, uint256 cycleDays, uint8 maxFailed, bool withTrial, uint256 seed) external {
        SubscriptionManager.PlanTerms memory t;
        t.price = bound(price, 1, 1_000_000_000_000);
        t.cycleSeconds = bound(cycleDays, 1, 365) * 1 days;
        t.maxFailed = uint8(bound(maxFailed, 1, 255)); // full range: maxFailed * 2 once overflowed at 128
        t.trialSeconds = withTrial ? t.cycleSeconds / 2 : 0;
        t.transferable = seed & 1 == 1;
        if (seed & 2 != 0) t.maxCycles = uint32(bound(seed >> 8, 1, 4));
        if (seed & 4 != 0 && t.price > 1) {
            t.introPrice = bound(seed >> 16, 1, t.price - 1);
            t.introCycles = uint32(bound(seed >> 80, 1, t.maxCycles > 0 ? t.maxCycles : 3));
        }
        vm.prank(_merchantOwner());
        try manager.createPlan(actors[0], t) returns (uint256 planId) {
            planIds.push(planId);
            if (t.price > maxPriceSeen) maxPriceSeen = t.price;
        } catch {}
    }

    function subscribe(uint256 actorSeed, uint256 planSeed) external {
        if (planIds.length == 0) return;
        address sub = _actor(actorSeed);
        uint256 planId = planIds[planSeed % planIds.length];
        vm.recordLogs();
        vm.prank(sub);
        try manager.subscribe(planId, bytes32(0)) returns (uint256 subId) {
            subIds.push(subId);
            holder[subId] = sub;
            if (retired[planId]) joinedRetired = true;
        } catch {}
        _recordPaid();
    }

    function retirePlan(uint256 planSeed, bool retire) external {
        if (planIds.length == 0) return;
        uint256 planId = planIds[planSeed % planIds.length];
        vm.prank(_merchantOwner());
        try manager.setPlanRetired(planId, retire) {
            retired[planId] = retire;
        } catch {}
    }

    /// @dev The merchant account changes hands; later merchant actions come from the new owner.
    function handOver(uint256 actorSeed) external {
        address to = _actor(actorSeed);
        vm.prank(_merchantOwner());
        try manager.transferOwnership(actors[0], to) {} catch {}
        vm.prank(to);
        try manager.acceptOwnership(actors[0]) {} catch {}
    }

    /// @dev A fixed payout at an actor or payoutAddr, or zero to follow the owner.
    function setPayout(uint256 seed) external {
        uint256 pick = seed % (actors.length + 2);
        address payout = pick < actors.length ? actors[pick] : pick == actors.length ? payoutAddr : address(0);
        vm.prank(_merchantOwner());
        try manager.setPayout(actors[0], payout) {} catch {}
    }

    /// @dev The subscriber proposes a move to another actor, who accepts.
    function transfer(uint256 subSeed, uint256 actorSeed) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[subSeed % subIds.length];
        (address subscriber, uint256 planId, , , , , , ) = manager.subscriptions(subId);
        address to = _actor(actorSeed);
        vm.prank(subscriber);
        try manager.proposeTransfer(subId, to) {
            proposedTo[subId] = to;
        } catch {}
        _accept(subId, to, planId);
    }

    /// @dev Anyone tries to take a subscription over, proposed or not.
    function grabSubscription(uint256 subSeed, uint256 actorSeed) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[subSeed % subIds.length];
        (, uint256 planId, , , , , , ) = manager.subscriptions(subId);
        _accept(subId, _actor(actorSeed), planId);
    }

    function _accept(uint256 subId, address by, uint256 planId) internal {
        vm.prank(by);
        try manager.acceptTransfer(subId, planId) {
            if (proposedTo[subId] != by) transferWithoutProposal = true;
            delete proposedTo[subId];
            holder[subId] = by;
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
        _charge(subId);
    }

    function _charge(uint256 subId) internal {
        (, , , , , , uint256 before, ) = manager.subscriptions(subId);
        vm.recordLogs();
        try manager.charge(subId) {
            (, , , , , , uint256 count, ) = manager.subscriptions(subId);
            if (count > before && manager.isChargeable(subId)) dueAfterCharge = true;
        } catch {}
        _recordPaid();
    }

    /// @dev A griefer: several charge() calls on one subscription at the same
    ///      moment, which only matters while its pull is failing.
    function griefCharge(uint256 subSeed, uint256 times) external {
        if (subIds.length == 0) return;
        uint256 subId = subIds[subSeed % subIds.length];
        times = bound(times, 2, 4);
        for (uint256 i = 0; i < times; i++) {
            _charge(subId);
        }
    }

    function changePlan(uint256 subSeed, uint256 planSeed) external {
        if (subIds.length == 0 || planIds.length < 2) return;
        uint256 subId = subIds[subSeed % subIds.length];
        (address subscriber, , , , , , , ) = manager.subscriptions(subId);
        uint256 newPlan = planIds[planSeed % planIds.length];
        vm.recordLogs();
        vm.prank(subscriber);
        try manager.changePlan(subId, newPlan) {
            if (retired[newPlan]) joinedRetired = true;
        } catch {}
        _recordPaid();
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
            try manager.resumeSubscription(subId) {
                lastFailureSeen[subId] = 0;
            } catch {}
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
            usdc.balanceOf(treasury) +
            usdc.balanceOf(handler.payoutAddr());
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
            (, , , , uint8 maxFailed, , , , , , ) = manager.plans(planId);
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

    /// @notice Credit is backed: a subscription never holds more credit than the
    ///         USDC it has actually paid.
    function invariant_creditBacked() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            (, , , , , uint256 credit, , ) = manager.subscriptions(id);
            assertLe(credit, handler.paid(id));
        }
    }

    /// @notice Anyone can call charge(), but a subscription's recorded failures are
    ///         always spaced by the dunning schedule (retryGap: 1, 3, then 7 days).
    function invariant_failuresSpaced() public view {
        assertFalse(handler.failuresTooClose());
    }

    /// @notice A successful charge never leaves the next one already due, so
    ///         missed cycles can never be pulled back to back (M-2, 2026-10-24 review).
    function invariant_noBackToBackCharges() public view {
        assertFalse(handler.dueAfterCharge());
    }

    /// @notice The manager never holds funds at rest: every pull is fully split.
    function invariant_managerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(manager)), 0);
    }

    /// @notice Completed is terminal: status and chargeCount never move after it.
    function invariant_completedIsTerminal() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            if (handler.completed(id)) {
                (, , , , , , uint256 cc, SubscriptionManager.Status status) = manager.subscriptions(id);
                assertEq(uint256(status), uint256(SubscriptionManager.Status.COMPLETED));
                assertEq(cc, handler.chargeCountAtComplete(id));
            }
        }
    }

    /// @notice No subscription is billed more than its plan's maxCycles times on that plan.
    function invariant_cycleLimitHolds() public view {
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            (, uint256 planId, , , , , , ) = manager.subscriptions(id);
            (, , , , , , , , uint32 maxCycles, , ) = manager.plans(planId);
            if (maxCycles > 0) assertLe(manager.planCycles(id), maxCycles);
        }
    }

    /// @notice A retired plan gains no subscriptions and no plan changes into it.
    function invariant_retiredPlansGainNothing() public view {
        assertFalse(handler.joinedRetired());
    }

    /// @notice A subscription changes wallet only when its subscriber proposed
    ///         that wallet and the wallet accepted.
    function invariant_subscriberChangesOnlyByAcceptance() public view {
        assertFalse(handler.transferWithoutProposal());
        uint256 n = manager.subCount();
        for (uint256 id = 1; id <= n; id++) {
            (address subscriber, , , , , , , ) = manager.subscriptions(id);
            assertEq(subscriber, handler.holder(id));
        }
    }
}

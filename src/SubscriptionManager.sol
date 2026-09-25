// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPermit2} from "./IPermit2.sol";

/// @title Levy SubscriptionManager
/// @notice Pull-based USDC subscription billing. Merchants define plans, subscribers
///         grant an allowance once, and anyone (the keeper in practice) triggers
///         per-cycle pulls. Billing is in advance: each pull pays for the cycle
///         that starts at it, and without a trial the first cycle is paid at
///         subscribe. Failed keeper pulls never revert: they are recorded on-chain
///         so the off-chain dunning engine can retry, and the subscription
///         auto-pauses after maxFailed attempts.
/// @dev Money math: ALL amounts are 6-decimal USDC units via the ERC-20 interface.
///      Native 18-decimal values must never enter this contract. Integer arithmetic
///      only; division rounds down and dust stays with the merchant.
contract SubscriptionManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant MAX_CYCLE = 365 days * 10;

    enum Status {
        TRIAL,
        ACTIVE,
        PAST_DUE,
        PAUSED,
        CANCELLED
    }

    struct Plan {
        address merchant;
        uint256 price; // 6-decimal USDC per cycle. Immutable: repricing = new plan.
        uint256 cycleSeconds;
        uint256 trialSeconds;
        uint256 graceSeconds; // informational; dunning schedule lives off-chain
        uint8 maxFailed;
        bool exists;
    }

    struct Subscription {
        address subscriber;
        uint256 planId;
        uint64 start;
        uint64 nextChargeAt;
        uint64 failedAttempts;
        uint256 credit; // proration credit, 6-decimal USDC. Always backed by USDC this merchant received.
        uint256 chargeCount;
        Status status;
    }

    IERC20 public immutable usdc;
    address public immutable feeRouter;
    IPermit2 public immutable permit2;

    /// @notice Permit2 on Arc mainnet/testnet: the canonical address, same as
    ///         Ethereum (see VERIFICATION.md). Pass a different address at
    ///         construction for testing.
    address public constant PERMIT2_ARC = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint256 public planCount;
    uint256 public subCount;
    mapping(uint256 => Plan) public plans;
    mapping(uint256 => Subscription) public subscriptions;

    event PlanCreated(uint256 indexed planId, address indexed merchant, uint256 price, uint256 cycleSeconds);
    event Subscribed(uint256 indexed subId, address indexed subscriber, uint256 indexed planId, uint64 nextChargeAt);
    event Charged(
        uint256 indexed subId,
        uint256 amount,
        uint256 fee,
        bytes32 indexed invoiceRef,
        uint256 chargeCount
    );
    event ChargeFailed(uint256 indexed subId, uint64 failedAttempts);
    event AutoPaused(uint256 indexed subId);
    event Paused(uint256 indexed subId);
    event Resumed(uint256 indexed subId);
    event Cancelled(uint256 indexed subId);
    event PlanChanged(uint256 indexed subId, uint256 indexed oldPlanId, uint256 indexed newPlanId, uint256 credit);

    error UnknownPlan();
    error UnknownSubscription();
    error BadPlanParams();
    error NotChargeable();
    error NotSubscriberOrMerchant();
    error NotSubscriber();
    error SamePlan();
    error BadPermitSpender();
    error BadPermitToken();
    error ZeroAddress();
    error PaymentFailed();
    error DifferentMerchant();

    constructor(address _usdc, address _feeRouter, address _permit2) {
        if (_usdc == address(0) || _feeRouter == address(0) || _permit2 == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(_usdc);
        feeRouter = _feeRouter;
        permit2 = IPermit2(_permit2);
    }

    /// @notice Merchant creates a billing plan. Price is immutable afterwards.
    function createPlan(
        uint256 price,
        uint256 cycleSeconds,
        uint256 trialSeconds,
        uint256 graceSeconds,
        uint8 maxFailed
    ) external returns (uint256 planId) {
        if (price == 0 || cycleSeconds == 0 || cycleSeconds > MAX_CYCLE || maxFailed == 0) {
            revert BadPlanParams();
        }
        if (trialSeconds >= cycleSeconds) revert BadPlanParams();

        planId = ++planCount;
        plans[planId] = Plan({
            merchant: msg.sender,
            price: price,
            cycleSeconds: cycleSeconds,
            trialSeconds: trialSeconds,
            graceSeconds: graceSeconds,
            maxFailed: maxFailed,
            exists: true
        });
        emit PlanCreated(planId, msg.sender, price, cycleSeconds);
    }

    /// @notice Subscriber starts a subscription. Requires a prior approve() or
    ///         Permit2 allowance covering at least price * expected cycles.
    ///         Without a trial the first cycle is pulled now, and a failed
    ///         pull reverts the subscribe.
    function subscribe(uint256 planId) external nonReentrant returns (uint256 subId) {
        return _subscribe(planId, msg.sender);
    }

    /// @notice One-transaction subscribe via Uniswap Permit2. The subscriber
    ///         signs a PermitSingle off-chain (EIP-712) authorizing this
    ///         contract as spender, then submits the permit and subscribe
    ///         atomically.
    /// @dev The permit's spender must be this contract and the token must be
    ///      USDC, otherwise the signature authorizes something we cannot use.
    ///      Only the signer can submit. The permit does not bind a plan, so if
    ///      anyone could relay it, a relayer (or anyone copying it from the
    ///      mempool) could subscribe the owner to a plan of their own and pull
    ///      the first cycle at once.
    ///      The signed amount is the subscriber's choice; later charges simply
    ///      fail (and dunning handles it) once it runs out.
    function subscribeWithPermit2(
        uint256 planId,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 subId) {
        if (permitSingle.spender != address(this)) revert BadPermitSpender();
        if (permitSingle.details.token != address(usdc)) revert BadPermitToken();
        permit2.permit(msg.sender, permitSingle, signature);
        return _subscribe(planId, msg.sender);
    }

    function _subscribe(uint256 planId, address subscriber) internal returns (uint256 subId) {
        Plan memory plan = plans[planId];
        if (!plan.exists) revert UnknownPlan();

        subId = ++subCount;
        uint64 start = uint64(block.timestamp);
        uint64 firstCharge = plan.trialSeconds > 0
            ? start + uint64(plan.trialSeconds)
            : start + uint64(plan.cycleSeconds);

        subscriptions[subId] = Subscription({
            subscriber: subscriber,
            planId: planId,
            start: start,
            nextChargeAt: firstCharge,
            failedAttempts: 0,
            credit: 0,
            chargeCount: 0,
            status: plan.trialSeconds > 0 ? Status.TRIAL : Status.ACTIVE
        });
        emit Subscribed(subId, subscriber, planId, firstCharge);

        // Advance billing: without a trial the first cycle is paid up front.
        if (plan.trialSeconds == 0 && !_collect(subId, subscriptions[subId], plan)) {
            revert PaymentFailed();
        }
    }

    /// @notice Pull one cycle's payment. Permissionless: the pull can only move
    ///         the subscriber's pre-approved funds to the correct merchant, so
    ///         there is nothing for an attacker to gain by calling it.
    /// @dev Never reverts on payment failure. Failures are recorded for dunning.
    function charge(uint256 subId) external nonReentrant {
        Subscription storage sub = subscriptions[subId];
        if (sub.subscriber == address(0)) revert UnknownSubscription();
        if (
            sub.status != Status.TRIAL &&
            sub.status != Status.ACTIVE &&
            sub.status != Status.PAST_DUE
        ) revert NotChargeable();
        if (block.timestamp < sub.nextChargeAt) revert NotChargeable();

        Plan memory plan = plans[sub.planId];
        if (!_collect(subId, sub, plan)) {
            // Credit survives the failure: the subscriber still paid for it.
            _recordFailure(subId, sub, plan);
            return;
        }

        sub.nextChargeAt = sub.nextChargeAt + uint64(plan.cycleSeconds);
        sub.failedAttempts = 0;
        if (sub.status == Status.TRIAL || sub.status == Status.PAST_DUE) {
            sub.status = Status.ACTIVE;
        }
    }

    /// @notice Bill one cycle of `plan`: proration credit first (excess carries
    ///         forward), then pull the rest and split it 99/1. Returns false,
    ///         with nothing changed, if the pull fails.
    function _collect(uint256 subId, Subscription storage sub, Plan memory plan) internal returns (bool) {
        uint256 due;
        uint256 fee;
        if (sub.credit >= plan.price) {
            // Fully covered by credit: the cycle is paid, no movement.
            sub.credit -= plan.price;
        } else {
            due = plan.price - sub.credit;
            if (!_tryPull(sub.subscriber, due)) return false;
            sub.credit = 0;
            fee = due / FEE_BPS; // rounds down; sub-cent dust stays with merchant
            usdc.safeTransfer(plan.merchant, due - fee);
            usdc.safeTransfer(feeRouter, fee);
        }

        sub.chargeCount += 1;
        emit Charged(subId, due, fee, keccak256(abi.encode(subId, sub.chargeCount)), sub.chargeCount);
        return true;
    }

    /// @notice Attempt the ERC-20 pull. Returns false instead of reverting so the
    ///         keeper's transaction survives and dunning state is recorded.
    /// @dev Tries a direct transferFrom first (classic approve flow), then falls
    ///      back to a Permit2 allowance (subscribeWithPermit2 flow). Permit2's
    ///      amount is uint160; larger pulls are impossible there by construction.
    function _tryPull(address from, uint256 amount) internal returns (bool) {
        try usdc.transferFrom(from, address(this), amount) returns (bool ok) {
            if (ok) return true;
        } catch {}
        if (amount > type(uint160).max) return false;
        try permit2.transferFrom(from, address(this), uint160(amount), address(usdc)) {
            return true;
        } catch {
            return false;
        }
    }

    function _recordFailure(uint256 subId, Subscription storage sub, Plan memory plan) internal {
        sub.failedAttempts += 1;
        emit ChargeFailed(subId, sub.failedAttempts);
        if (sub.failedAttempts >= plan.maxFailed && sub.status != Status.PAST_DUE) {
            sub.status = Status.PAST_DUE;
        }
        if (sub.failedAttempts >= plan.maxFailed * 2) {
            // Long-dead subscription: stop burning keeper gas on it.
            sub.status = Status.PAUSED;
            emit AutoPaused(subId);
        }
    }

    function pauseSubscription(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        _onlySubscriberOrMerchant(sub);
        if (sub.status == Status.PAUSED || sub.status == Status.CANCELLED) revert NotChargeable();
        sub.status = Status.PAUSED;
        emit Paused(subId);
    }

    /// @notice Resume a paused subscription as a fresh start. Paused time is
    ///         never billed: if the next charge date passed during the pause,
    ///         billing restarts now (an overdue cycle is forgiven, as with
    ///         changePlan). The failure count resets for a new dunning run.
    function resumeSubscription(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        _onlySubscriberOrMerchant(sub);
        if (sub.status != Status.PAUSED) revert NotChargeable();
        if (sub.nextChargeAt < block.timestamp) sub.nextChargeAt = uint64(block.timestamp);
        sub.failedAttempts = 0;
        sub.status = Status.ACTIVE;
        emit Resumed(subId);
    }

    function cancelSubscription(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        _onlySubscriberOrMerchant(sub);
        if (sub.status == Status.CANCELLED) revert NotChargeable();
        sub.status = Status.CANCELLED;
        emit Cancelled(subId);
    }

    /// @notice Switch to another plan from the same merchant. The new plan's
    ///         first cycle starts and is billed now. Unused paid time on the old
    ///         plan becomes credit against it; leftover credit carries forward.
    /// @dev Credit only ever comes from a cycle that was paid, and only moves
    ///      between plans of the merchant who was paid, so it is always backed.
    function changePlan(uint256 subId, uint256 newPlanId) external nonReentrant {
        Subscription storage sub = subscriptions[subId];
        if (sub.subscriber == address(0)) revert UnknownSubscription();
        if (msg.sender != sub.subscriber) revert NotSubscriber();
        if (newPlanId == sub.planId) revert SamePlan();
        Plan memory newPlan = plans[newPlanId];
        if (!newPlan.exists) revert UnknownPlan();
        if (
            sub.status != Status.TRIAL &&
            sub.status != Status.ACTIVE &&
            sub.status != Status.PAST_DUE
        ) revert NotChargeable();

        Plan memory oldPlan = plans[sub.planId];
        if (newPlan.merchant != oldPlan.merchant) revert DifferentMerchant();

        // Before the first charge nextChargeAt marks the end of an unpaid
        // trial; after it, the end of a paid cycle.
        uint256 credit = sub.credit;
        if (sub.chargeCount > 0 && sub.nextChargeAt > block.timestamp) {
            uint256 remaining = sub.nextChargeAt - block.timestamp;
            if (remaining > oldPlan.cycleSeconds) remaining = oldPlan.cycleSeconds;
            credit += (oldPlan.price * remaining) / oldPlan.cycleSeconds; // rounds down
        }

        uint256 oldPlanId = sub.planId;
        sub.planId = newPlanId;
        sub.credit = credit;
        emit PlanChanged(subId, oldPlanId, newPlanId, credit);

        if (!_collect(subId, sub, newPlan)) revert PaymentFailed();
        sub.nextChargeAt = uint64(block.timestamp) + uint64(newPlan.cycleSeconds);
        sub.failedAttempts = 0;
        sub.status = Status.ACTIVE; // a paid plan change ends a trial and clears past-due
    }

    function isChargeable(uint256 subId) external view returns (bool) {
        Subscription memory sub = subscriptions[subId];
        if (sub.subscriber == address(0)) return false;
        return
            (sub.status == Status.TRIAL ||
                sub.status == Status.ACTIVE ||
                sub.status == Status.PAST_DUE) &&
            block.timestamp >= sub.nextChargeAt;
    }

    function _onlySubscriberOrMerchant(Subscription memory sub) internal view {
        if (sub.subscriber == address(0)) revert UnknownSubscription();
        Plan memory plan = plans[sub.planId];
        if (msg.sender != sub.subscriber && msg.sender != plan.merchant) {
            revert NotSubscriberOrMerchant();
        }
    }
}

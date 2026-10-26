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
///         subscribe. A failed pull is recorded on-chain instead of reverting, on
///         the dunning schedule (retryGap: 1, 3, then 7 days apart) so the
///         off-chain keeper can retry; the subscription goes PAST_DUE at
///         maxFailed failures and auto-pauses at twice that.
///         A plan belongs to a merchant account, the address that created it,
///         whose owner and payout address can change. Plans can be retired,
///         limited to a number of cycles and discounted for their first
///         cycles, and a subscription can move to a new wallet that accepts it
///         (docs/manager-v2-design.md).
/// @dev Money math: ALL amounts are 6-decimal USDC units via the ERC-20 interface.
///      Native 18-decimal values must never enter this contract. Integer arithmetic
///      only; division rounds down and dust stays with the merchant.
contract SubscriptionManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant MAX_CYCLE = 365 days * 10;
    /// @notice Shortest billing cycle. Bounds how often the keeper pays gas to
    ///         charge a subscription (a self-paying one never fails, so never
    ///         auto-pauses) and how fast a mistaken approval can be drained.
    uint256 public constant MIN_CYCLE = 1 days;
    /// @notice Shortest gaps between recorded failures of one subscription: the
    ///         dunning schedule the keeper retries on, enforced here. charge() is
    ///         permissionless, so without them anyone could record failures as
    ///         fast as allowed and pause a subscription long before its schedule
    ///         says (H-1 in the 2026-09-25 review, then finding 2 of the
    ///         2026-10-02 review against a flat 1-day gap). Successful charges
    ///         are never held back by them.
    uint256 public constant RETRY_GAP_FIRST = 1 days; // before the 2nd failure
    uint256 public constant RETRY_GAP_SECOND = 3 days; // before the 3rd
    uint256 public constant RETRY_GAP_LATER = 7 days; // before the 4th and every one after

    enum Status {
        TRIAL,
        ACTIVE,
        PAST_DUE,
        PAUSED,
        CANCELLED,
        COMPLETED // every cycle of a limited plan billed; terminal, like CANCELLED
    }

    struct Plan {
        address merchant; // the merchant account: the address that created it (see ownerOf, payoutOf)
        uint256 price; // 6-decimal USDC per cycle. Immutable: repricing = new plan.
        uint256 cycleSeconds;
        uint256 trialSeconds;
        uint8 maxFailed;
        bool exists;
        bool retired; // no new subscriptions or plan changes into it; the one field that changes
        bool transferable; // its subscriptions may move to a new wallet
        uint32 maxCycles; // cycles billed before a subscription completes; 0 = no limit
        uint256 introPrice; // below price; billed for a subscription's first introCycles cycles
        uint32 introCycles;
    }

    /// @notice A plan's terms as createPlan takes them; see Plan for each field.
    struct PlanTerms {
        uint256 price;
        uint256 cycleSeconds;
        uint256 trialSeconds;
        uint8 maxFailed;
        uint32 maxCycles;
        uint256 introPrice;
        uint32 introCycles;
        bool transferable;
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
    /// @notice The merchant's own reference for a subscription, set at
    ///         subscribe (e.g. their customer or checkout id). Public on-chain,
    ///         so it must be an opaque token, and chosen by whoever subscribes,
    ///         so merchants should issue unguessable ones. Zero means none.
    mapping(uint256 => bytes32) public subscriptionRef;
    /// @notice When the subscription's last failed charge was recorded; zero
    ///         when none has been since it started or was last resumed.
    mapping(uint256 => uint64) public lastFailedAt;
    /// @notice True while the subscription is paused by its merchant, not by
    ///         the subscriber or by dunning. A resume restarts billing against
    ///         the subscriber's allowance, so the merchant may resume only a
    ///         pause it made itself; the subscriber may resume any pause.
    mapping(uint256 => bool) public pausedByMerchant;
    /// @notice The price billed for the subscription's cycle in progress, written
    ///         on every billed cycle, including one paid entirely from credit.
    ///         changePlan credits unused time at this price, never at the plan's
    ///         full price, which an intro cycle did not pay.
    mapping(uint256 => uint256) public billedPrice;
    /// @notice Cycles billed on the subscription's current plan, counted against
    ///         its maxCycles. A plan change restarts the count.
    mapping(uint256 => uint256) public planCycles;
    /// @notice Intro-priced cycles the subscription has left: set at subscribe
    ///         from its plan and cleared by a plan change, so intro prices stay
    ///         with the plan a subscription started on.
    mapping(uint256 => uint256) public introCyclesLeft;
    /// @notice The wallet a subscription is being moved to, until it accepts.
    mapping(uint256 => address) public pendingTransfer;

    /// @notice Who acts for a merchant account when that is not the account
    ///         itself (zero). Read through ownerOf.
    mapping(address => address) internal accountOwner;
    /// @notice The owner a merchant account is being handed to, until it accepts.
    mapping(address => address) public pendingOwner;
    /// @notice Where a merchant account's share goes when fixed; zero follows
    ///         the owner. Read through payoutOf.
    mapping(address => address) internal accountPayout;

    event PlanCreated(uint256 indexed planId, address indexed merchant, uint256 price, uint256 cycleSeconds);
    event Subscribed(
        uint256 indexed subId,
        address indexed subscriber,
        uint256 indexed planId,
        uint64 nextChargeAt,
        bytes32 ref
    );
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
    event PlanRetired(uint256 indexed planId, bool retired);
    event Completed(uint256 indexed subId);
    event TransferProposed(uint256 indexed subId, address indexed from, address indexed to);
    event SubscriptionTransferred(uint256 indexed subId, address indexed from, address indexed to);
    event PayoutChanged(address indexed account, address indexed payout);
    event OwnershipTransferStarted(address indexed account, address indexed pendingOwner);
    event OwnershipTransferred(address indexed account, address indexed previousOwner, address indexed newOwner);

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
    error RetryTooSoon();
    error NotOwner();
    error NotPendingOwner();
    error BadPayout();
    error RetiredPlan();
    error NotTransferable();
    error NotPendingSubscriber();
    error PlanMismatch();
    error CycleLimitReached();

    constructor(address _usdc, address _feeRouter, address _permit2) {
        if (_usdc == address(0) || _feeRouter == address(0) || _permit2 == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(_usdc);
        feeRouter = _feeRouter;
        permit2 = IPermit2(_permit2);
    }

    /// @notice Create a billing plan for merchant account `account`, which the
    ///         caller must own (an address owns itself until it hands ownership
    ///         on, so createPlan(msg.sender, ...) needs no setup). Terms are
    ///         immutable afterwards; only retirement changes.
    function createPlan(address account, PlanTerms calldata terms) external returns (uint256 planId) {
        if (msg.sender != ownerOf(account)) revert NotOwner();
        if (
            terms.price == 0 ||
            terms.cycleSeconds < MIN_CYCLE ||
            terms.cycleSeconds > MAX_CYCLE ||
            terms.maxFailed == 0
        ) revert BadPlanParams();
        if (terms.trialSeconds >= terms.cycleSeconds) revert BadPlanParams();
        // Intro pricing is a discount only: a higher first price would become
        // proration credit at the next plan change.
        if (terms.introCycles > 0) {
            if (terms.introPrice == 0 || terms.introPrice >= terms.price) revert BadPlanParams();
            if (terms.maxCycles > 0 && terms.introCycles > terms.maxCycles) revert BadPlanParams();
        } else if (terms.introPrice != 0) {
            revert BadPlanParams();
        }

        planId = ++planCount;
        plans[planId] = Plan({
            merchant: account,
            price: terms.price,
            cycleSeconds: terms.cycleSeconds,
            trialSeconds: terms.trialSeconds,
            maxFailed: terms.maxFailed,
            exists: true,
            retired: false,
            transferable: terms.transferable,
            maxCycles: terms.maxCycles,
            introPrice: terms.introPrice,
            introCycles: terms.introCycles
        });
        emit PlanCreated(planId, account, terms.price, terms.cycleSeconds);
    }

    /// @notice Stop new subscriptions and plan changes into the plan, or allow
    ///         them again. Existing subscriptions are untouched.
    function setPlanRetired(uint256 planId, bool retired) external {
        Plan storage plan = plans[planId];
        if (!plan.exists) revert UnknownPlan();
        if (msg.sender != ownerOf(plan.merchant)) revert NotOwner();
        plan.retired = retired;
        emit PlanRetired(planId, retired);
    }

    /// @notice Who acts for merchant account `account`: the account itself until
    ///         it hands ownership on.
    function ownerOf(address account) public view returns (address) {
        address owner = accountOwner[account];
        return owner == address(0) ? account : owner;
    }

    /// @notice Where `account`'s 99% goes: its fixed payout address if it set
    ///         one, otherwise its current owner.
    function payoutOf(address account) public view returns (address) {
        address payout = accountPayout[account];
        return payout == address(0) ? ownerOf(account) : payout;
    }

    /// @notice Fix where the account's share goes, from the next collection;
    ///         zero follows the owner again. One step: a payout address need not
    ///         be able to call back, and the owner can correct a mistake at once.
    ///         A blocklisted payout makes the account's charges revert until a
    ///         new one is set (SECURITY_REVIEW.md section 9, open item 5).
    function setPayout(address account, address payout) external {
        if (msg.sender != ownerOf(account)) revert NotOwner();
        if (payout == address(this)) revert BadPayout(); // the share would be stuck here
        accountPayout[account] = payout;
        emit PayoutChanged(account, payout);
    }

    /// @notice Step one of handing the account to a new owner, who takes over
    ///         only once it calls acceptOwnership, so a mistyped address never
    ///         takes control. Proposing again replaces the proposal; zero
    ///         withdraws it.
    function transferOwnership(address account, address newOwner) external {
        if (msg.sender != ownerOf(account)) revert NotOwner();
        pendingOwner[account] = newOwner;
        emit OwnershipTransferStarted(account, newOwner);
    }

    /// @notice Step two: the proposed owner takes over. A fixed payout stays;
    ///         one that follows the owner now follows the new owner.
    function acceptOwnership(address account) external {
        if (msg.sender != pendingOwner[account]) revert NotPendingOwner();
        emit OwnershipTransferred(account, ownerOf(account), msg.sender);
        accountOwner[account] = msg.sender;
        delete pendingOwner[account];
    }

    /// @notice Subscriber starts a subscription. Requires a prior approve() or
    ///         Permit2 allowance covering at least price * expected cycles.
    ///         Without a trial the first cycle is pulled now, and a failed
    ///         pull reverts the subscribe. `ref` is the merchant's reference
    ///         (see subscriptionRef), or zero.
    function subscribe(uint256 planId, bytes32 ref) external nonReentrant returns (uint256 subId) {
        return _subscribe(planId, msg.sender, ref);
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
    ///      Anyone who sees the signed permit can submit it to Permit2 first
    ///      and use up its nonce. So a failed permit is not fatal while the
    ///      subscriber's Permit2 allowance already covers the first cycle (at
    ///      the intro price, if the plan has one) and has not expired;
    ///      otherwise Permit2's own error is re-thrown.
    function subscribeWithPermit2(
        uint256 planId,
        bytes32 ref,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 subId) {
        if (permitSingle.spender != address(this)) revert BadPermitSpender();
        if (permitSingle.details.token != address(usdc)) revert BadPermitToken();
        try permit2.permit(msg.sender, permitSingle, signature) {} catch (bytes memory reason) {
            (uint160 amount, uint48 expiration, ) = permit2.allowance(msg.sender, address(usdc), address(this));
            Plan memory plan = plans[planId];
            uint256 firstPrice = plan.introCycles > 0 ? plan.introPrice : plan.price;
            if (amount < firstPrice || expiration < block.timestamp) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
        return _subscribe(planId, msg.sender, ref);
    }

    function _subscribe(uint256 planId, address subscriber, bytes32 ref) internal returns (uint256 subId) {
        Plan memory plan = plans[planId];
        if (!plan.exists) revert UnknownPlan();
        if (plan.retired) revert RetiredPlan();

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
        if (ref != bytes32(0)) subscriptionRef[subId] = ref;
        if (plan.introCycles > 0) introCyclesLeft[subId] = plan.introCycles;
        emit Subscribed(subId, subscriber, planId, firstCharge, ref);

        // Advance billing: without a trial the first cycle is paid up front.
        if (plan.trialSeconds == 0 && !_collect(subId, subscriptions[subId], plan)) {
            revert PaymentFailed();
        }
    }

    /// @notice Pull one cycle's payment. Permissionless: the pull can only move
    ///         the subscriber's pre-approved funds to the correct merchant, so
    ///         there is nothing for an attacker to gain by calling it.
    /// @dev A failed pull is recorded for dunning instead of reverting, no
    ///      sooner than retryGap after the last recorded failure; a failing
    ///      call before that reverts RetryTooSoon and changes nothing.
    ///      A successful pull after failed ones starts a fresh cycle now, as
    ///      resume does, so the overdue time is forgiven, not billed; so is a
    ///      cycle that ended with no charge at all. A successful charge
    ///      therefore never leaves the next one already due, and missed
    ///      cycles cannot be pulled back to back.
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

        uint64 next = sub.nextChargeAt + uint64(plan.cycleSeconds);
        if (sub.failedAttempts > 0 || next <= block.timestamp) {
            next = uint64(block.timestamp) + uint64(plan.cycleSeconds);
        }
        sub.nextChargeAt = next;
        sub.failedAttempts = 0;
        if (sub.status == Status.TRIAL || sub.status == Status.PAST_DUE) {
            sub.status = Status.ACTIVE;
        }
    }

    /// @notice Bill one cycle of `plan`: proration credit first (excess carries
    ///         forward), then pull the rest and split it 99/1, the merchant's
    ///         share to the account's payout address. The cycle costs the plan's
    ///         introPrice while the subscription has intro cycles left. The
    ///         cycle that reaches a limited plan's maxCycles completes the
    ///         subscription. Returns false, with nothing changed, if the pull
    ///         fails.
    /// @dev The one place a cycle is billed, so the only writer of billedPrice,
    ///      planCycles, introCyclesLeft and COMPLETED. billedPrice is written
    ///      on both branches: written only after a pull, a downgrade paid from
    ///      credit would keep the old, higher price, and every round trip
    ///      between two plans would add credit nobody paid for.
    function _collect(uint256 subId, Subscription storage sub, Plan memory plan) internal returns (bool) {
        // Backstop: status checks stop a completed subscription before this.
        if (plan.maxCycles > 0 && planCycles[subId] >= plan.maxCycles) revert CycleLimitReached();
        bool intro = introCyclesLeft[subId] > 0 && plan.introCycles > 0;
        uint256 price = intro ? plan.introPrice : plan.price;

        uint256 due;
        uint256 fee;
        if (sub.credit >= price) {
            // Fully covered by credit: the cycle is paid, no movement.
            sub.credit -= price;
        } else {
            due = price - sub.credit;
            if (!_tryPull(sub.subscriber, due)) return false;
            sub.credit = 0;
            fee = due / FEE_BPS; // rounds down; sub-cent dust stays with merchant
            usdc.safeTransfer(payoutOf(plan.merchant), due - fee);
            usdc.safeTransfer(feeRouter, fee);
        }

        billedPrice[subId] = price;
        if (intro) introCyclesLeft[subId] -= 1;
        uint256 cycles = ++planCycles[subId];
        sub.chargeCount += 1;
        emit Charged(subId, due, fee, keccak256(abi.encode(subId, sub.chargeCount)), sub.chargeCount);
        if (plan.maxCycles > 0 && cycles >= plan.maxCycles) {
            sub.status = Status.COMPLETED;
            emit Completed(subId);
        }
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

    /// @notice How long after the last recorded failure the next one may be
    ///         recorded, given `failures` recorded since the last success.
    ///         With maxFailed = m, the earliest auto-pause is therefore
    ///         1 + 3 + 7 * (2m - 3) days after the first failure (1 day for m = 1).
    function retryGap(uint256 failures) public pure returns (uint256) {
        if (failures == 0) return 0;
        if (failures == 1) return RETRY_GAP_FIRST;
        if (failures == 2) return RETRY_GAP_SECOND;
        return RETRY_GAP_LATER;
    }

    function _recordFailure(uint256 subId, Subscription storage sub, Plan memory plan) internal {
        if (block.timestamp < lastFailedAt[subId] + retryGap(sub.failedAttempts)) revert RetryTooSoon();
        lastFailedAt[subId] = uint64(block.timestamp);
        sub.failedAttempts += 1;
        emit ChargeFailed(subId, sub.failedAttempts);
        if (sub.failedAttempts >= plan.maxFailed && sub.status != Status.PAST_DUE) {
            sub.status = Status.PAST_DUE;
        }
        if (sub.failedAttempts >= uint256(plan.maxFailed) * 2) { // uint8 * 2 would overflow at 128
            // Long-dead subscription: stop burning keeper gas on it.
            sub.status = Status.PAUSED;
            emit AutoPaused(subId);
        }
    }

    function pauseSubscription(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        _onlySubscriberOrMerchant(sub);
        if (sub.status == Status.PAUSED || sub.status == Status.CANCELLED || sub.status == Status.COMPLETED) {
            revert NotChargeable();
        }
        sub.status = Status.PAUSED;
        pausedByMerchant[subId] = msg.sender != sub.subscriber;
        emit Paused(subId);
    }

    /// @notice Resume a paused subscription as a fresh start. Paused time is
    ///         never billed: if the next charge date passed during the pause,
    ///         billing restarts now (an overdue cycle is forgiven, as with
    ///         changePlan). The failure count and the retry timer reset for a
    ///         new dunning run. The subscriber can resume any pause; the
    ///         merchant only its own (see pausedByMerchant).
    function resumeSubscription(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        _onlySubscriberOrMerchant(sub);
        if (sub.status != Status.PAUSED) revert NotChargeable();
        if (msg.sender != sub.subscriber && !pausedByMerchant[subId]) revert NotSubscriber();
        if (sub.nextChargeAt < block.timestamp) sub.nextChargeAt = uint64(block.timestamp);
        sub.failedAttempts = 0;
        delete lastFailedAt[subId];
        delete pausedByMerchant[subId];
        sub.status = Status.ACTIVE;
        emit Resumed(subId);
    }

    function cancelSubscription(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        _onlySubscriberOrMerchant(sub);
        if (sub.status == Status.CANCELLED || sub.status == Status.COMPLETED) revert NotChargeable();
        sub.status = Status.CANCELLED;
        emit Cancelled(subId);
    }

    /// @notice Switch to another plan from the same merchant. The new plan's
    ///         first cycle starts and is billed now, at its full price: intro
    ///         prices stay with the plan a subscription started on. Unused paid
    ///         time on the old plan becomes credit against it; leftover credit
    ///         carries forward.
    /// @dev Credit only ever comes from a cycle that was paid, at the price it
    ///      was billed at, and only moves between plans of the merchant who was
    ///      paid, so it is always backed.
    function changePlan(uint256 subId, uint256 newPlanId) external nonReentrant {
        Subscription storage sub = subscriptions[subId];
        if (sub.subscriber == address(0)) revert UnknownSubscription();
        if (msg.sender != sub.subscriber) revert NotSubscriber();
        if (newPlanId == sub.planId) revert SamePlan();
        Plan memory newPlan = plans[newPlanId];
        if (!newPlan.exists) revert UnknownPlan();
        if (newPlan.retired) revert RetiredPlan();
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
            // At the price this cycle was billed at, not the plan's full price,
            // which an intro cycle did not pay.
            credit += (billedPrice[subId] * remaining) / oldPlan.cycleSeconds; // rounds down
        }

        uint256 oldPlanId = sub.planId;
        sub.planId = newPlanId;
        sub.credit = credit;
        // Before billing: the new plan starts its own cycle count, and no intro
        // cycle carries over, so hopping between intro plans cannot keep one.
        delete planCycles[subId];
        delete introCyclesLeft[subId];
        emit PlanChanged(subId, oldPlanId, newPlanId, credit);

        if (!_collect(subId, sub, newPlan)) revert PaymentFailed();
        sub.nextChargeAt = uint64(block.timestamp) + uint64(newPlan.cycleSeconds);
        sub.failedAttempts = 0;
        // A paid plan change ends a trial and clears past-due, but a completion
        // reached by its own charge (a one-cycle plan) stands.
        if (sub.status != Status.COMPLETED) sub.status = Status.ACTIVE;
    }

    /// @notice Step one of moving a subscription to a new wallet, by its
    ///         subscriber only: a merchant path would let a stolen owner key hand
    ///         customers' subscriptions to itself. The plan must allow transfers.
    ///         Proposing again replaces the proposal; zero withdraws it.
    function proposeTransfer(uint256 subId, address to) external {
        Subscription storage sub = subscriptions[subId];
        if (sub.subscriber == address(0)) revert UnknownSubscription();
        if (msg.sender != sub.subscriber) revert NotSubscriber();
        _checkTransferable(sub);
        pendingTransfer[subId] = to;
        emit TransferProposed(subId, msg.sender, to);
    }

    /// @notice Step two: the proposed wallet takes the subscription over, with
    ///         its id, ref, paid time, credit, counters and dunning state, and
    ///         later charges pull from its allowance. Only that wallet can
    ///         accept: one allowance pays all of a wallet's Levy subscriptions,
    ///         so nobody else may decide it pays for this one. `planId` must be
    ///         the current plan, so the plan cannot be switched between the
    ///         proposal and the acceptance.
    function acceptTransfer(uint256 subId, uint256 planId) external {
        Subscription storage sub = subscriptions[subId];
        if (sub.subscriber == address(0)) revert UnknownSubscription();
        if (msg.sender != pendingTransfer[subId]) revert NotPendingSubscriber();
        if (planId != sub.planId) revert PlanMismatch();
        // Again: since proposing, the subscriber may have moved to a plan that
        // does not allow transfers, or the subscription may have ended.
        _checkTransferable(sub);
        delete pendingTransfer[subId];
        emit SubscriptionTransferred(subId, sub.subscriber, msg.sender);
        sub.subscriber = msg.sender;
    }

    function _checkTransferable(Subscription memory sub) internal view {
        if (!plans[sub.planId].transferable) revert NotTransferable();
        if (sub.status == Status.CANCELLED || sub.status == Status.COMPLETED) revert NotChargeable();
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
        if (msg.sender != sub.subscriber && msg.sender != ownerOf(plan.merchant)) {
            revert NotSubscriberOrMerchant();
        }
    }
}

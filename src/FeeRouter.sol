// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Levy FeeRouter
/// @notice Collects the 1% protocol fee from SubscriptionManager.
///         Phase 1: sweep() forwards everything to the treasury multisig.
///         Phase 2 (LEVY token): sweep() splits 50% to buyback-and-burn and
///         50% to the staking rewards pool. That logic lands with the token;
///         this contract is the seam it plugs into.
contract FeeRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public treasury;
    /// @notice The treasury's proposed successor, until it accepts; zero when none.
    address public pendingTreasury;

    event Swept(uint256 amount, address indexed treasury);
    event TreasuryProposed(address indexed treasury, address indexed pendingTreasury);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error OnlyTreasury();
    error OnlyPendingTreasury();
    error ZeroAddress();

    constructor(address _usdc, address _treasury) {
        if (_usdc == address(0) || _treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    /// @notice Move the full fee balance to treasury. Permissionless: the
    ///         destination is fixed, so there is nothing to steal by calling it.
    function sweep() external {
        uint256 balance = usdc.balanceOf(address(this));
        usdc.safeTransfer(treasury, balance);
        emit Swept(balance, treasury);
    }

    /// @notice Step one of moving the treasury: the current treasury proposes
    ///         its successor, which takes over only once it calls
    ///         acceptTreasury, so a mistyped address never receives the fees.
    ///         Proposing again replaces the proposal.
    function proposeTreasury(address _treasury) external {
        if (msg.sender != treasury) revert OnlyTreasury();
        if (_treasury == address(0)) revert ZeroAddress();
        pendingTreasury = _treasury;
        emit TreasuryProposed(treasury, _treasury);
    }

    /// @notice Step two: the proposed treasury takes over.
    function acceptTreasury() external {
        if (msg.sender != pendingTreasury) revert OnlyPendingTreasury();
        emit TreasuryUpdated(treasury, msg.sender);
        treasury = msg.sender;
        delete pendingTreasury;
    }
}

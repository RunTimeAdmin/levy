// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Uniswap Permit2 interface: only the functions Levy uses.
/// @dev Full Permit2 repo: https://github.com/Uniswap/permit2
///      On Arc mainnet/testnet: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
///      the canonical address (same as Ethereum; see VERIFICATION.md).
interface IPermit2 {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    /// @notice Set an allowance in Permit2's store via an EIP-712 signature.
    /// @param owner The token owner signing the permit.
    /// @param permitSingle Token, amount, expiration, nonce, spender, deadline.
    /// @param signature EIP-712 signature by owner.
    function permit(
        address owner,
        PermitSingle memory permitSingle,
        bytes calldata signature
    ) external;

    /// @notice Pull tokens using a Permit2 allowance previously set via permit().
    /// @dev amount is uint160 in Permit2; callers must bound it.
    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;

    /// @notice The allowance `spender` holds over `owner`'s `token`.
    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

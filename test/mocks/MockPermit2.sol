// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPermit2} from "../../src/IPermit2.sol";

/// @notice Test-only Permit2 stand-in. Implements the real Permit2 EIP-712
///         scheme (domain "Permit2", PermitSingle typehash) so tests exercise
///         the full sign -> permit -> subscribeWithPermit2 flow with genuine
///         signatures. Allowance accounting mirrors Permit2's: permit() sets
///         (owner, token, spender) -> amount; transferFrom() spends it down.
/// @dev The mock ALSO requires the owner to have approve()d the mock for the
///      token, mirroring real Permit2 (which pulls via its own ERC-20 allowance).
contract MockPermit2 is IPermit2 {
    bytes32 private constant _PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 private constant _PERMIT_SINGLE_TYPEHASH =
        keccak256(
            "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
            "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
        );
    bytes32 private constant _EIP712DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    // owner => token => spender => amount
    mapping(address => mapping(address => mapping(address => uint256))) public allowance;
    // owner => token => spender => nonce
    mapping(address => mapping(address => mapping(address => uint48))) public nonce;

    error BadSignature();
    error ExpiredPermit();
    error BadNonce();
    error InsufficientPermitAllowance();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712DOMAIN_TYPEHASH,
                keccak256("Permit2"),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(
        address owner,
        PermitSingle memory permitSingle,
        bytes calldata signature
    ) external override {
        if (block.timestamp > permitSingle.sigDeadline) revert ExpiredPermit();
        if (permitSingle.details.nonce != nonce[owner][permitSingle.details.token][permitSingle.spender]) {
            revert BadNonce();
        }

        bytes32 detailsHash = keccak256(
            abi.encode(
                _PERMIT_DETAILS_TYPEHASH,
                permitSingle.details.token,
                permitSingle.details.amount,
                permitSingle.details.expiration,
                permitSingle.details.nonce
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        _PERMIT_SINGLE_TYPEHASH,
                        detailsHash,
                        permitSingle.spender,
                        permitSingle.sigDeadline
                    )
                )
            )
        );

        (bytes32 r, bytes32 s, uint8 v) = _split(signature);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert BadSignature();

        allowance[owner][permitSingle.details.token][permitSingle.spender] = permitSingle.details.amount;
        nonce[owner][permitSingle.details.token][permitSingle.spender] =
            permitSingle.details.nonce + 1;
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external override {
        uint256 allowed = allowance[from][token][msg.sender];
        if (allowed < amount) revert InsufficientPermitAllowance();
        allowance[from][token][msg.sender] = allowed - amount;
        // Mirrors real Permit2: pulls via its own ERC-20 allowance from `from`.
        IERC20(token).transferFrom(from, to, amount);
    }

    function _split(bytes calldata sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "bad sig length");
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Canonical Uniswap Permit2 (ISignatureTransfer subset). Same address on every chain incl. Robinhood 4663/46630.
interface IPermit2Witness {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

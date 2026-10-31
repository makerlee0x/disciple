// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Minimal LayerZero lzRead surface used by Disciple
/// @notice The production adapter is a thin wrapper over LayerZero OAppRead. The hook builds `callData`
///         itself (the caller never supplies a price). `onLzRead` is delivered by the endpoint, not the user.
///         Tests use MockLzRead. The full lzRead stack is not vendored: it does not match this repo's solc pin
///         cleanly and we are not deploying. See DESIGN.md.
interface ILzRead {
    struct EvmRead {
        uint32 targetEid;
        address target;
        bytes callData;
        uint64 minConfirmations;
    }

    function quoteRead(EvmRead calldata read) external view returns (uint256 nativeFee);

    /// @dev Implementations must later call `ILzReadConsumer.onLzRead` on `msg.sender` with the target's return data.
    function sendRead(EvmRead calldata read, address refundAddress) external payable returns (bytes32 guid);
}

interface ILzReadConsumer {
    function onLzRead(bytes32 guid, bytes calldata result) external;
}

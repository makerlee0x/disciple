// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Minimal LayerZero lzRead surface used by Disciple
/// @notice Production wiring is `DiscipleLzRead`. It sends a ReadCodecV1 command through Endpoint V2
///         and accepts the response only from that endpoint, on the configured read channel. The hook
///         builds `callData` itself. The caller never supplies a price. Tests use `MockLzRead`. The full
///         OApp library is not vendored. See DESIGN.md.
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

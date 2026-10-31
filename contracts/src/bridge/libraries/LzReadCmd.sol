// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LayerZero Read V1 command and executor option encoding
/// @notice Matches `ReadCodecV1` (one view call, no compute) and `ExecutorOptions` lzRead
///         (worker 1, option type 5). The read channel is the message destination. The reference
///         chain's endpoint id sits inside the command.
library LzReadCmd {
    uint16 internal constant CMD_VERSION = 1;
    uint8 internal constant REQUEST_VERSION = 1;
    uint16 internal constant RESOLVER_SINGLE_VIEW = 1;
    uint8 internal constant WORKER_EXECUTOR = 1;
    uint8 internal constant OPTION_TYPE_LZREAD = 5;
    uint16 internal constant OPTIONS_TYPE_3 = 3;

    error CmdTooLarge();

    /// @dev Timestamp read of one view. `confirmations` blocks must sit on top of `timestamp`.
    function encode(uint32 targetEid, address target, bytes memory callData, uint16 confirmations, uint64 timestamp)
        internal
        pure
        returns (bytes memory)
    {
        uint256 size = callData.length + 35;
        if (size > type(uint16).max) revert CmdTooLarge();
        return abi.encodePacked(
            CMD_VERSION,
            uint16(1),
            uint16(1),
            REQUEST_VERSION,
            uint16(1),
            RESOLVER_SINGLE_VIEW,
            uint16(size),
            targetEid,
            uint8(0),
            timestamp,
            confirmations,
            target,
            callData
        );
    }

    /// @dev Type-3 executor option asking for `gas` on `lzReceive` and `calldataSize` bytes of response.
    function lzReadOptions(uint128 gas, uint32 calldataSize) internal pure returns (bytes memory option) {
        bytes memory body = abi.encodePacked(gas, calldataSize);
        option = abi.encodePacked(OPTIONS_TYPE_3, WORKER_EXECUTOR, uint16(body.length + 1), OPTION_TYPE_LZREAD, body);
    }
}

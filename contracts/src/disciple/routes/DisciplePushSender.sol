// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DiscipleSourceReader} from "./DiscipleSourceReader.sol";
import {
    ILayerZeroEndpointV2Lite,
    MessagingParams,
    MessagingFee,
    MessagingReceipt,
    LibConfig
} from "./ILayerZeroEndpointV2Lite.sol";

/// @title DisciplePushSender
/// @notice Route: any LayerZero chain -> any other (Robinhood -> Ethereum, Base <-> Arbitrum, HyperEVM, ...), as a
///         normal LayerZero message. Deploy one per home chain. Anyone calls `push`; it reads the source itself and
///         sends the raw state to a DisciplePushReceiver, which trusts only this sender for this chain's eid.
///
///         No owner and no delegate. Its DVN/library config can be fixed once in the constructor; otherwise the
///         endpoint's defaults for each pathway apply (check they are live: some new pathways default to a dead DVN).
///         Keeper cost carried in the message: LayerZero fee + PUSH_GAS * basefee, paid back on the pool's chain by
///         the receiver only where both chains use ETH for gas (see DisciplePushReceiver).
contract DisciplePushSender is DiscipleSourceReader {
    uint256 public constant PUSH_GAS = 150_000;

    ILayerZeroEndpointV2Lite public immutable endpoint;

    event Pushed(uint32 indexed dstEid, PoolId indexed id, bytes32 guid, uint256 a, uint256 b, address keeper);

    constructor(ILayerZeroEndpointV2Lite endpoint_, LibConfig[] memory config) {
        endpoint = endpoint_;
        for (uint256 i = 0; i < config.length; i++) {
            endpoint_.setConfig(address(this), config[i].lib, config[i].params);
        }
    }

    /// @notice LayerZero fee for a push with `gas` for the receiver's lzReceive on the destination.
    function quote(uint32 dstEid, bytes32 receiver, PoolId id, uint8 kind, address target, bytes32 v4Id, uint128 gas)
        external
        view
        returns (uint256)
    {
        (uint256 a, uint256 b) = read(kind, target, v4Id);
        return endpoint.quote(_params(dstEid, receiver, _message(id, kind, target, v4Id, a, b, 0), gas), address(this))
            .nativeFee;
    }

    function push(uint32 dstEid, bytes32 receiver, PoolId id, uint8 kind, address target, bytes32 v4Id, uint128 gas)
        external
        payable
        returns (bytes32 guid)
    {
        (uint256 a, uint256 b) = read(kind, target, v4Id);
        // the fee does not depend on the cost field (fixed-size encoding), so quote with 0 and fill it in after
        MessagingParams memory mp = _params(dstEid, receiver, _message(id, kind, target, v4Id, a, b, 0), gas);
        uint256 fee = endpoint.quote(mp, address(this)).nativeFee;
        mp.message = _message(id, kind, target, v4Id, a, b, fee + PUSH_GAS * block.basefee);
        MessagingReceipt memory r = endpoint.send{value: msg.value}(mp, msg.sender);
        guid = r.guid;
        emit Pushed(dstEid, id, guid, a, b, msg.sender);
    }

    function _message(PoolId id, uint8 kind, address target, bytes32 v4Id, uint256 a, uint256 b, uint256 cost)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(id, kind, target, v4Id, a, b, uint64(block.timestamp), msg.sender, cost);
    }

    /// @dev Executor option type 3: lzReceive with `gas` (no native drop).
    function _params(uint32 dstEid, bytes32 receiver, bytes memory message, uint128 gas)
        internal
        pure
        returns (MessagingParams memory)
    {
        bytes memory options = abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas);
        return MessagingParams(dstEid, receiver, message, options, false);
    }
}

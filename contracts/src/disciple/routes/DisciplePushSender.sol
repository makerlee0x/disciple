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
/// @notice Route: any LayerZero chain -> any other (Ethereum -> Robinhood in v0), as a normal LayerZero message.
///         Deploy one per home chain. Anyone calls `push`; it reads every requested source itself and sends their raw
///         state in ONE message to a DisciplePushReceiver, which trusts only this sender for this chain's eid.
///
///         Batching (maker, 2026-11-04: per-pool messages cost too much): one message carries any number of
///         sources, and each source lists the pools priced from it on the destination. The message's whole cost is
///         split evenly over all listed pools, so ten pools on one source pay a tenth each.
///
///         Keeper cost carried in the message: the LayerZero fee plus this transaction's gas, measured here
///         (intrinsic + calldata at its ABI length + execution) at basefee only, so priority fees and padded
///         calldata cannot inflate it. No owner and no delegate; the DVN/executor config is fixed at construction.
contract DisciplePushSender is DiscipleSourceReader {
    /// @dev Gas not visible to gasleft(): the 21k intrinsic cost, the endpoint's refund of excess fee, the event.
    uint256 public constant OVERHEAD_GAS = 30_000;
    /// @dev endpoint.send after the quote (library, DVN and executor jobs, nonce, event) plus the second encode,
    ///      per message. Calibrated on the Ethereum fork; the read, encode and quote before it are measured live.
    uint256 public constant SEND_GAS = 70_000;

    struct Req {
        uint8 kind;
        address target;
        bytes32 v4Id;
        PoolId[] pools; // destination pools priced from this source
    }

    /// @dev One source's observation as sent. Must match DisciplePushReceiver.Obs.
    struct Obs {
        uint8 kind;
        address target;
        bytes32 v4Id;
        uint256 a;
        uint256 b;
        PoolId[] pools;
    }

    ILayerZeroEndpointV2Lite public immutable endpoint;

    event Pushed(uint32 indexed dstEid, bytes32 guid, uint256 sources, uint256 pools, uint256 cost, address keeper);

    error Empty();

    constructor(ILayerZeroEndpointV2Lite endpoint_, LibConfig[] memory config) {
        endpoint = endpoint_;
        for (uint256 i = 0; i < config.length; i++) {
            endpoint_.setConfig(address(this), config[i].lib, config[i].params);
        }
    }

    /// @notice LayerZero fee for a push of `reqs` with `gas` for the receiver's lzReceive on the destination.
    function quote(uint32 dstEid, bytes32 receiver, Req[] calldata reqs, uint128 gas) external view returns (uint256) {
        (Obs[] memory obs,) = _read(reqs);
        return endpoint.quote(_params(dstEid, receiver, _message(obs, 0), gas), address(this)).nativeFee;
    }

    function push(uint32 dstEid, bytes32 receiver, Req[] calldata reqs, uint128 gas)
        external
        payable
        returns (bytes32 guid)
    {
        uint256 g0 = gasleft();
        (Obs[] memory obs, uint256 n) = _read(reqs);
        // the fee does not depend on the cost field (fixed-size word), so quote with 0 and fill it in after
        MessagingParams memory mp = _params(dstEid, receiver, _message(obs, 0), gas);
        uint256 fee = endpoint.quote(mp, address(this)).nativeFee;
        uint256 used = g0 - gasleft();
        uint256 cost = fee + (used + SEND_GAS + OVERHEAD_GAS + 16 * _abiLen(reqs)) * block.basefee;
        mp.message = _message(obs, cost);
        MessagingReceipt memory r = endpoint.send{value: msg.value}(mp, msg.sender);
        guid = r.guid;
        emit Pushed(dstEid, guid, obs.length, n, cost, msg.sender);
    }

    function _read(Req[] calldata reqs) internal view returns (Obs[] memory obs, uint256 n) {
        if (reqs.length == 0) revert Empty();
        obs = new Obs[](reqs.length);
        for (uint256 i = 0; i < reqs.length; i++) {
            Req calldata q = reqs[i];
            if (q.pools.length == 0) revert Empty();
            (uint256 a, uint256 b) = read(q.kind, q.target, q.v4Id);
            obs[i] = Obs(q.kind, q.target, q.v4Id, a, b, q.pools);
            n += q.pools.length;
        }
    }

    /// @dev Message: (observedAt, keeper, cost for the whole message, observations).
    function _message(Obs[] memory obs, uint256 cost) internal view returns (bytes memory) {
        return abi.encode(uint64(block.timestamp), msg.sender, cost, obs);
    }

    /// @dev ABI length of push's calldata for these requests (what an honest caller sends; padding is not counted).
    function _abiLen(Req[] calldata reqs) internal pure returns (uint256 len) {
        len = 4 + 32 * 6; // selector, 4 head words, array offset + length
        for (uint256 i = 0; i < reqs.length; i++) {
            len += 32 * (6 + reqs[i].pools.length); // offset, 3 words + pools offset, pools length, pools
        }
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

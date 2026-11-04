// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IDisciplePriceTarget} from "./DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite, Origin, LibConfig} from "./ILayerZeroEndpointV2Lite.sol";

/// @title DisciplePushReceiver
/// @notice Sits beside one Disciple hook and receives LayerZero push messages. Accepts a message only from the
///         endpoint, and only if it came from the DisciplePushSender registered for that source chain. Then it
///         hands the raw source state to the hook with the source chain's eid; the hook checks the pool's home
///         chain and source and applies the usual freshness, order and replay rules.
///
///         No owner. Peers (one sender per source chain) and whether that chain pays gas in ETH are fixed at
///         construction. The hook is bound once by the deployer (the hook's address depends on this contract's, so
///         it cannot be a constructor argument); after that nothing can change.
///         Keeper refunds: the sender's cost is in its chain's gas token. It is passed through only for chains
///         whose gas token is ETH, like the hook's (Ethereum, Robinhood, Arbitrum, Base); otherwise zero, so a
///         HyperEVM keeper is not refunded in mismatched units.
contract DisciplePushReceiver {
    ILayerZeroEndpointV2Lite public immutable endpoint;
    address public immutable deployer;
    IDisciplePriceTarget public hook;

    mapping(uint32 eid => bytes32 sender) public peers;
    mapping(uint32 eid => bool) public ethGas;

    error OnlyEndpoint();
    error UnknownPeer();
    error AlreadyBound();

    constructor(
        ILayerZeroEndpointV2Lite endpoint_,
        uint32[] memory eids,
        address[] memory senders,
        bool[] memory ethGas_,
        LibConfig[] memory config
    ) {
        endpoint = endpoint_;
        deployer = msg.sender;
        for (uint256 i = 0; i < eids.length; i++) {
            peers[eids[i]] = bytes32(uint256(uint160(senders[i])));
            ethGas[eids[i]] = ethGas_[i];
        }
        for (uint256 i = 0; i < config.length; i++) {
            endpoint_.setConfig(address(this), config[i].lib, config[i].params);
        }
    }

    /// @notice One-time binding to the hook. Deployer only; final.
    function bind(IDisciplePriceTarget hook_) external {
        if (msg.sender != deployer || address(hook) != address(0)) revert AlreadyBound();
        hook = hook_;
    }

    function lzReceive(Origin calldata o, bytes32, bytes calldata message, address, bytes calldata) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        if (o.sender == bytes32(0) || peers[o.srcEid] != o.sender) revert UnknownPeer();
        (
            PoolId id,
            uint8 kind,
            address target,
            bytes32 v4Id,
            uint256 a,
            uint256 b,
            uint64 observedAt,
            address keeper,
            uint256 cost
        ) = abi.decode(message, (PoolId, uint8, address, bytes32, uint256, uint256, uint64, address, uint256));
        if (!ethGas[o.srcEid]) cost = 0;
        hook.onBridgePrice(id, o.srcEid, kind, target, v4Id, a, b, observedAt, keeper, cost);
    }

    /// @notice LayerZero asks this before the first message on a pathway.
    function allowInitializePath(Origin calldata o) external view returns (bool) {
        return o.sender != bytes32(0) && peers[o.srcEid] == o.sender;
    }

    /// @notice Unordered delivery (the hook orders by observation time).
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }
}

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
///         Add-only owner (maker, 2026-11-04). Peers (one sender per source chain) and whether that chain pays gas
///         in ETH can be set at construction, and the owner can later ADD a peer for a source chain that has none,
///         with that chain's DVN config. A peer, once set, can never be changed or removed, so a pool priced from an
///         existing chain can never be redirected. The owner can hand over or renounce the role. The hook is bound
///         once by the owner (the hook's address depends on this contract's, so it cannot be a constructor argument).
///         Keeper refunds: the sender's cost is in its chain's gas token. It is passed through only for chains
///         whose gas token is ETH, like the hook's (Ethereum, Robinhood, Arbitrum, Base); otherwise zero, so a
///         HyperEVM keeper is not refunded in mismatched units.
contract DisciplePushReceiver {
    ILayerZeroEndpointV2Lite public immutable endpoint;
    address public owner;
    IDisciplePriceTarget public hook;

    mapping(uint32 eid => bytes32 sender) public peers;
    mapping(uint32 eid => bool) public ethGas;
    /// @dev This chain's keeper gas per message, shared by its listed pools: the keeper's commitVerification
    ///      transaction plus the fixed part of its lzReceive transaction (each with 21k and calldata). Depends on the
    ///      receive DVN set, so it is set at construction: DiscipleRoutesV0.destMsgGas.
    uint256 public immutable msgGas;
    /// @dev This chain's keeper gas per listed pool inside lzReceive (the hook's delivery, its refund transfer and
    ///      the pool's calldata). Ethereum fork, Foundry 1.9.0 (cold, as on chain), 2026-11-04.
    uint256 public constant POOL_GAS = 157_000;

    error OnlyEndpoint();
    error NoValue();
    error UnknownPeer();
    error AlreadyBound();
    error OnlyOwner();
    error PeerSet();
    error BadPeer();
    error ForeignConfig();

    event PeerAdded(uint32 indexed eid, address sender, bool ethGas);
    event OwnerChanged(address owner);
    event Undelivered(PoolId indexed id);

    constructor(
        ILayerZeroEndpointV2Lite endpoint_,
        uint32[] memory eids,
        address[] memory senders,
        bool[] memory ethGas_,
        LibConfig[] memory config,
        uint256 msgGas_
    ) {
        endpoint = endpoint_;
        msgGas = msgGas_;
        owner = msg.sender;
        if (eids.length != senders.length || eids.length != ethGas_.length) revert BadPeer();
        for (uint256 i = 0; i < eids.length; i++) {
            _addPeer(eids[i], senders[i], ethGas_[i]);
        }
        for (uint256 i = 0; i < config.length; i++) {
            endpoint_.setConfig(address(this), config[i].lib, config[i].params);
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @notice One-time binding to the hook. Owner only; final.
    function bind(IDisciplePriceTarget hook_) external onlyOwner {
        if (address(hook) != address(0)) revert AlreadyBound();
        hook = hook_;
    }

    /// @notice Switch on a new source chain: its sender, whether it pays gas in ETH, and its DVN/library config.
    ///         Only for a chain with no peer yet, and the config may only name that chain, so nothing already live
    ///         can be changed.
    function addPeer(uint32 eid, address sender, bool ethGas_, LibConfig[] calldata config) external onlyOwner {
        _addPeer(eid, sender, ethGas_);
        for (uint256 i = 0; i < config.length; i++) {
            for (uint256 j = 0; j < config[i].params.length; j++) {
                if (config[i].params[j].eid != eid) revert ForeignConfig();
            }
            endpoint.setConfig(address(this), config[i].lib, config[i].params);
        }
    }

    /// @notice Hand the add-only role to someone else, or to address(0) to renounce it for good.
    function setOwner(address next) external onlyOwner {
        owner = next;
        emit OwnerChanged(next);
    }

    function _addPeer(uint32 eid, address sender, bool ethGas_) private {
        if (sender == address(0) || eid == 0) revert BadPeer();
        if (peers[eid] != bytes32(0)) revert PeerSet();
        peers[eid] = bytes32(uint256(uint160(sender)));
        ethGas[eid] = ethGas_;
        emit PeerAdded(eid, sender, ethGas_);
    }

    /// @dev One source's observation as received. Must match DisciplePushSender.Obs.
    struct Obs {
        uint8 kind;
        address target;
        bytes32 v4Id;
        uint256 a;
        uint256 b;
        PoolId[] pools;
    }

    /// @notice Delivers one batched message: every source's observation to every pool listed for it. The message's
    ///         cost is split evenly over the listed pools; each pool refunds its share only if it accepts the price
    ///         under its own rules. One pool refusing or failing does not stop the others.
    function lzReceive(Origin calldata o, bytes32, bytes calldata message, address, bytes calldata) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        // nothing here can pass ETH on, so a delivery carrying value is refused (retry it without value)
        if (msg.value != 0) revert NoValue();
        if (o.sender == bytes32(0) || peers[o.srcEid] != o.sender) revert UnknownPeer();
        (uint64 observedAt, address keeper, uint256 cost, Obs[] memory obs) =
            abi.decode(message, (uint64, address, uint256, Obs[]));
        uint256 n;
        for (uint256 i = 0; i < obs.length; i++) {
            n += obs[i].pools.length;
        }
        if (n == 0) return;
        // each listed pool: its share of the home-chain cost (ETH-gas homes only) plus this chain's delivery cost,
        // the per-message part split evenly; the pool refunds it (* 1.2) only if it accepts the price
        uint256 share = (ethGas[o.srcEid] ? cost / n : 0) + (msgGas / n + POOL_GAS) * block.basefee;
        for (uint256 i = 0; i < obs.length; i++) {
            Obs memory x = obs[i];
            for (uint256 j = 0; j < x.pools.length; j++) {
                try hook.onBridgePrice(x.pools[j], o.srcEid, x.kind, x.target, x.v4Id, x.a, x.b, observedAt, keeper, share) {}
                catch {
                    emit Undelivered(x.pools[j]);
                }
            }
        }
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

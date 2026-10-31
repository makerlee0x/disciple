// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ILzRead, ILzReadConsumer} from "./interfaces/ILzRead.sol";
import {ILayerZeroEndpointV2, ILayerZeroReceiver} from "./interfaces/ILayerZeroEndpointV2.sol";
import {LzReadCmd} from "./libraries/LzReadCmd.sol";

/// @title Disciple's LayerZero V2 lzRead adapter
/// @notice One adapter per hook, on the pool's chain. `updatePrice` asks this contract to send a
///         Read command. The command names the reference chain, the lens, and the view. The
///         response is delivered by the endpoint to `lzReceive`, and only then does this contract
///         call `hook.onLzRead`. There is no function that accepts a price from an EOA.
///
///         The owner is the endpoint delegate. After deployment the owner sets the read library
///         and the DVN config on the endpoint for `readChannel`. This contract does not pick a DVN.
contract DiscipleLzRead is ILzRead, ILayerZeroReceiver {
    /// @dev Gas the executor should allow for `lzReceive` plus the hook's callback.
    uint128 internal constant READ_GAS = 800_000;
    /// @dev Room for a `(uint256, uint256)` or a slot tuple, with padding.
    uint32 internal constant RESPONSE_BYTES = 256;

    ILayerZeroEndpointV2 public immutable endpoint;
    uint16 public immutable confirmations;
    address public owner;
    address public hook;
    uint32 public readChannel;
    mapping(uint32 channel => bytes32 peer) public peers;

    error OnlyOwner();
    error OnlyHook();
    error OnlyEndpoint();
    error BadConfig();
    error BadChannel();
    error BadPeer();

    event HookSet(address hook);
    event ReadChannelSet(uint32 channel, bool active);

    constructor(address endpoint_, uint32 readChannel_, uint16 confirmations_, address owner_) {
        if (endpoint_ == address(0) || readChannel_ == 0 || confirmations_ == 0 || owner_ == address(0)) {
            revert BadConfig();
        }
        endpoint = ILayerZeroEndpointV2(endpoint_);
        confirmations = confirmations_;
        owner = owner_;
        readChannel = readChannel_;
        peers[readChannel_] = bytes32(uint256(uint160(address(this))));
        endpoint.setDelegate(owner_);
    }

    /// @notice One-time. The hook is mined after this adapter exists, so the owner sets it once.
    function setHook(address hook_) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (hook != address(0) || hook_ == address(0)) revert BadConfig();
        hook = hook_;
        emit HookSet(hook_);
    }

    /// @notice Activate or replace the read channel. The peer is this adapter, which is what
    ///         LayerZero Read delivers back to. Only the owner.
    function setReadChannel(uint32 channel, bool active) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (channel == 0) revert BadConfig();
        if (!active && channel == readChannel) readChannel = 0;
        if (active) readChannel = channel;
        peers[channel] = active ? bytes32(uint256(uint160(address(this)))) : bytes32(0);
        emit ReadChannelSet(channel, active);
    }

    function quoteRead(EvmRead calldata read) external view returns (uint256 nativeFee) {
        ILayerZeroEndpointV2.MessagingFee memory fee = endpoint.quote(_params(read), address(this));
        return fee.nativeFee;
    }

    function sendRead(EvmRead calldata read, address refundAddress) external payable returns (bytes32 guid) {
        if (msg.sender != hook) revert OnlyHook();
        ILayerZeroEndpointV2.MessagingReceipt memory receipt =
            endpoint.send{value: msg.value}(_params(read), refundAddress);
        return receipt.guid;
    }

    function allowInitializePath(ILayerZeroEndpointV2.Origin calldata origin) external view returns (bool) {
        return origin.srcEid == readChannel && peers[origin.srcEid] == origin.sender;
    }

    /// @dev 0 tells the endpoint this path is not nonce-ordered. The hook orders results itself.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    function lzReceive(
        ILayerZeroEndpointV2.Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address,
        bytes calldata
    ) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        if (origin.srcEid != readChannel || readChannel == 0) revert BadChannel();
        if (peers[origin.srcEid] != origin.sender) revert BadPeer();
        if (hook == address(0)) revert BadConfig();
        ILzReadConsumer(hook).onLzRead(guid, message);
    }

    function _params(EvmRead calldata read) internal view returns (ILayerZeroEndpointV2.MessagingParams memory params) {
        if (readChannel == 0 || peers[readChannel] == bytes32(0)) revert BadChannel();
        uint16 conf = confirmations;
        if (read.minConfirmations > conf && read.minConfirmations <= type(uint16).max) {
            conf = uint16(read.minConfirmations);
        }
        uint64 ts = block.timestamp == 0 ? 1 : uint64(block.timestamp);
        params.dstEid = readChannel;
        params.receiver = peers[readChannel];
        params.message = LzReadCmd.encode(read.targetEid, read.target, read.callData, conf, ts);
        params.options = LzReadCmd.lzReadOptions(READ_GAS, RESPONSE_BYTES);
        params.payInLzToken = false;
    }
}

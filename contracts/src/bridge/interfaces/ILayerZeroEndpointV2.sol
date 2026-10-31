// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The slice of LayerZero Endpoint V2 that Disciple's read adapter calls.
///         Field order matches the protocol structs. DVN configuration is `setConfig` on the
///         endpoint, called by this adapter's delegate, not by the hook.
interface ILayerZeroEndpointV2 {
    struct MessagingParams {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        bool payInLzToken;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        MessagingFee fee;
    }

    struct Origin {
        uint32 srcEid;
        bytes32 sender;
        uint64 nonce;
    }

    function quote(MessagingParams calldata params, address sender) external view returns (MessagingFee memory);

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);

    function setDelegate(address delegate) external;
}

/// @notice What the endpoint calls on the adapter. `nextNonce` of 0 means delivery is not ordered.
interface ILayerZeroReceiver {
    function allowInitializePath(ILayerZeroEndpointV2.Origin calldata origin) external view returns (bool);

    function nextNonce(uint32 eid, bytes32 sender) external view returns (uint64);

    function lzReceive(
        ILayerZeroEndpointV2.Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}

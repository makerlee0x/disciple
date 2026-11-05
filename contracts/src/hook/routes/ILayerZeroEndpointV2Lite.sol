// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The slice of LayerZero EndpointV2 the push route uses (same shapes as the official interface).
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

struct SetConfigParam {
    uint32 eid;
    uint32 configType;
    bytes config;
}

interface ILayerZeroEndpointV2Lite {
    function quote(MessagingParams calldata params, address sender) external view returns (MessagingFee memory);
    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
}

/// @notice One library config call, applied once at construction (no delegate is ever set, so it is final).
struct LibConfig {
    address lib;
    SetConfigParam[] params;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev ERC-4337 v0.7 packed user operation (same layout as eth-infinitism v0.7.0 `PackedUserOperation`).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @dev EntryPoint v0.7 PostOpMode (opSucceeded, opReverted, postOpReverted[unused in v0.7]).
enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

interface IPaymasterV07 {
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
}

/// @dev The EntryPoint v0.7 StakeManager surface the paymaster uses.
interface IEntryPointStakeV07 {
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC-6900 v0.8 module interfaces, as implemented by Alchemy Modular Account v2
///      (copied from erc6900/reference-implementation v0.8.0 to avoid a new dependency).
interface IERC165Like {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IModule is IERC165Like {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function moduleId() external view returns (string memory);
}

/// @dev ERC-4337 v0.7 packed user operation.
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

interface IValidationHookModule is IModule {
    function preUserOpValidationHook(uint32 entityId, PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        returns (uint256);
    function preRuntimeValidationHook(
        uint32 entityId,
        address sender,
        uint256 value,
        bytes calldata data,
        bytes calldata authorization
    ) external;
    function preSignatureValidationHook(uint32 entityId, address sender, bytes32 hash, bytes calldata signature)
        external
        view;
}

interface IExecutionHookModule is IModule {
    function preExecutionHook(uint32 entityId, address sender, uint256 value, bytes calldata data)
        external
        returns (bytes memory);
    function postExecutionHook(uint32 entityId, bytes calldata preExecHookData) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Minimal two-step ownership (SEC-04 hardening)
/// @notice `transferOwnership(newOwner)` only nominates; the nominee must call `acceptOwnership()`. A typo'd or
///         non-controllable address can never become owner. `transferOwnership(address(0))` cancels a nomination.
///         There is deliberately no `renounceOwnership`.
abstract contract Owned2Step {
    address public owner;
    address public pendingOwner;

    error OnlyOwner();
    error NotPendingOwner();

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address owner_) {
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function _checkOwner() internal view {
        if (msg.sender != owner) revert OnlyOwner();
    }

    /// @notice Nominate `newOwner` (address(0) cancels). Takes effect only when the nominee accepts.
    function transferOwnership(address newOwner) external {
        _checkOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Called by the nominee to complete the transfer.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }
}

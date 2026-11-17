// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title First-touch referral registry (§4 / LOCKED #18–#22)
/// @dev First touch counts right away (maker 2026-11-17: no deposit gate, nobody's money is held). Referral fees
///      go to the referral sink (treasury) and referrers are paid off-chain, so a fake wallet earns nothing here.
///      Self-referral (same wallet) blocked only.
contract ReferralRegistry is IReferralRegistry {
    mapping(address => address) private _referrerOf;
    address public owner;
    address public pendingOwner;
    /// @notice Owner-set contracts allowed to attribute on behalf of a wallet (e.g. a router that verified the
    ///         wallet's intent). Audit #3: everyone else may only attribute msg.sender itself.
    mapping(address => bool) public isAttestor;

    error OnlyOwner();
    error SelfReferral();
    error AlreadyAttributed();
    error NotWalletOrAttestor();
    error ZeroAddress();

    event OwnerTransferred(address indexed owner);

    event ReferrerAttributed(address indexed wallet, address indexed referrer);
    event AttestorSet(address indexed attestor, bool allowed);

    constructor(address owner_) {
        // Audit FR-04: an address(0) owner can never be recovered.
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    function setAttestor(address attestor, bool allowed) external {
        if (msg.sender != owner) revert OnlyOwner();
        isAttestor[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    /// @notice Two-step (audit 2026-11-17 L-27): nominates `newOwner`, who must call acceptOwnership.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OnlyOwner();
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert OnlyOwner();
        owner = msg.sender;
        delete pendingOwner;
        emit OwnerTransferred(msg.sender);
    }

    /// @inheritdoc IReferralRegistry
    function referrerOf(address wallet) external view override returns (address) {
        return _referrerOf[wallet];
    }

    /// @inheritdoc IReferralRegistry
    /// @dev Audit #3: caller must be `wallet` itself (EOA, or a smart account such as the session-key path
    ///      `account.execute(registry.tryAttribute(account, ref))`) or an owner-trusted attestor.
    ///      First touch is final: once set, a wallet's referrer never changes.
    function tryAttribute(address wallet, address referrer) external override returns (bool attributed) {
        if (msg.sender != wallet && !isAttestor[msg.sender]) revert NotWalletOrAttestor();
        if (referrer == wallet) revert SelfReferral();
        if (_referrerOf[wallet] != address(0)) revert AlreadyAttributed();
        if (referrer == address(0)) return false;
        _referrerOf[wallet] = referrer;
        emit ReferrerAttributed(wallet, referrer);
        return true;
    }
}

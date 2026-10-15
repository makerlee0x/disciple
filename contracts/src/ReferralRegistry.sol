// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Constants} from "./libraries/Constants.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title First-touch referral registry (§4 / LOCKED #18–#22)
/// @dev Attribution locks after: link → account → USDG deposit ≥ $10.
///      Self-referral (same wallet) blocked only.
contract ReferralRegistry is IReferralRegistry {
    mapping(address => address) private _referrerOf;
    mapping(address => uint256) public usdgDeposited;
    mapping(address => address) public pendingReferrer; // set before deposit gate clears

    address public depositHook; // authorized USDG deposit notifier
    address public owner;

    error OnlyOwner();
    error OnlyDepositHook();
    error SelfReferral();
    error AlreadyAttributed();

    event ReferrerPending(address indexed wallet, address indexed referrer);
    event ReferrerAttributed(address indexed wallet, address indexed referrer);
    event UsdgDepositRecorded(address indexed wallet, uint256 amount, uint256 total);

    constructor(address owner_) {
        owner = owner_;
    }

    function setDepositHook(address hook) external {
        if (msg.sender != owner) revert OnlyOwner();
        depositHook = hook;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OnlyOwner();
        owner = newOwner;
    }

    /// @inheritdoc IReferralRegistry
    function referrerOf(address wallet) external view override returns (address) {
        return _referrerOf[wallet];
    }

    /// @inheritdoc IReferralRegistry
    /// @dev Stores pending referrer; attribution finalizes on USDG gate.
    function tryAttribute(address wallet, address referrer) external override returns (bool attributed) {
        if (referrer == wallet) revert SelfReferral();
        if (_referrerOf[wallet] != address(0)) revert AlreadyAttributed();
        if (referrer == address(0)) return false;

        pendingReferrer[wallet] = referrer;
        emit ReferrerPending(wallet, referrer);

        // If gate already satisfied (deposit happened first), attribute now.
        if (usdgDeposited[wallet] >= Constants.REFERRAL_USDG_GATE) {
            _finalize(wallet, referrer);
            return true;
        }
        return false;
    }

    /// @inheritdoc IReferralRegistry
    function onUsdgDeposit(address wallet, uint256 amount) external override {
        if (msg.sender != depositHook) revert OnlyDepositHook();
        usdgDeposited[wallet] += amount;
        emit UsdgDepositRecorded(wallet, amount, usdgDeposited[wallet]);

        address pending = pendingReferrer[wallet];
        if (
            _referrerOf[wallet] == address(0) && pending != address(0) && pending != wallet
                && usdgDeposited[wallet] >= Constants.REFERRAL_USDG_GATE
        ) {
            _finalize(wallet, pending);
        }
    }

    function _finalize(address wallet, address referrer) internal {
        _referrerOf[wallet] = referrer;
        delete pendingReferrer[wallet];
        emit ReferrerAttributed(wallet, referrer);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title First-touch referral attribution (§4 / LOCKED #18–#22)
/// @dev Path: referral link → account → USDG deposit ≥ $10, then forever.
///      Same-wallet self-referral blocked only.
interface IReferralRegistry {
    function referrerOf(address wallet) external view returns (address);

    /// @notice Records `referrer` for `wallet` on first touch (no deposit gate). Called by the wallet or an attestor.
    /// @dev Only sets referrer if unset and referrer != wallet (no self-referral).
    function tryAttribute(address wallet, address referrer) external returns (bool attributed);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title First-touch referral attribution (§4 / LOCKED #18–#22)
/// @dev Path: referral link → account → USDG deposit ≥ $10, then forever.
///      Same-wallet self-referral blocked only.
interface IReferralRegistry {
    function referrerOf(address wallet) external view returns (address);

    /// @notice Hook: backend / deposit contract notifies after USDG deposit ≥ gate.
    /// @dev Only sets referrer if unset and referrer != wallet (no self-referral).
    function tryAttribute(address wallet, address referrer) external returns (bool attributed);

    /// @notice Called when USDG deposit confirms the gate (≥ usdgGate = $10 in USDG raw units).
    function onUsdgDeposit(address wallet, uint256 amount) external;
}

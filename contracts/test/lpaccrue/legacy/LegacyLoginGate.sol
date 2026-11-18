// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only stand-in for the removed LoginGate, so the verbatim pre-lp-accrue curve copy (BondingCurveV1)
///         can still run its Easy path in comparison tests. Nothing in src/ uses a login gate any more.
contract LegacyLoginGate {
    mapping(address => uint64) public verifiedUntil;

    function verify(address wallet, uint64 until) external {
        verifiedUntil[wallet] = until;
    }
}

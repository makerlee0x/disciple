// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DISCIPLE protocol constants
/// @notice Named constants locked in protocol-constitution.md (v0 / Robinhood Chain).
/// @dev Section references point at ../protocol-constitution.md
library Constants {
    // ── Supply (§2 Curve parameters / LOCKED #7) ─────────────────────────────
    uint8 internal constant TOKEN_DECIMALS = 18;
    uint256 internal constant TOTAL_SUPPLY = 7_000_000_000 * 1e18; // 7B fixed
    /// @dev ~72% of supply sold on the bonding curve before Pearly Gates graduation.
    uint256 internal constant CURVE_SOLD_BPS = 7200; // 72.00%

    // ── Curve market caps (§2 / LOCKED #6, §9 Tier Ladder) — LOCKED 2026-10-15 ─
    /// @dev Launch Pad start market cap (USD, 18-dec fixed-point for quote pricing).
    uint256 internal constant START_MCAP_USD = 7_000 * 1e18; // $7K
    /// @dev Pearly Gates graduation market cap.
    uint256 internal constant GRADUATION_MCAP_USD = 33_000 * 1e18; // $33K
    /// @dev Alias for GRADUATION_MCAP_USD.
    uint256 internal constant PEARLY_GATES_MCAP_USD = GRADUATION_MCAP_USD;

    // Tier ladder ranges (USD, whole dollars) — LOCKED 2026-10-15
    // Pre-grad evenly spaced $7K→$33K; post-grad roughly geometric to Seventh Heaven.
    uint256 internal constant TIER_LAUNCH_PAD_LO_USD = 7_000;
    uint256 internal constant TIER_LAUNCH_PAD_HI_USD = 12_000;
    uint256 internal constant TIER_LIMBO_LO_USD = 12_000;
    uint256 internal constant TIER_LIMBO_HI_USD = 18_000;
    uint256 internal constant TIER_ASCENSION_LO_USD = 18_000;
    uint256 internal constant TIER_ASCENSION_HI_USD = 25_000;
    uint256 internal constant TIER_NARROW_GATE_LO_USD = 25_000;
    uint256 internal constant TIER_NARROW_GATE_HI_USD = 33_000;
    uint256 internal constant TIER_PEARLY_GATES_LO_USD = 33_000;
    uint256 internal constant TIER_PEARLY_GATES_HI_USD = 55_000;
    uint256 internal constant TIER_FIRMAMENT_LO_USD = 55_000;
    uint256 internal constant TIER_FIRMAMENT_HI_USD = 100_000;
    uint256 internal constant TIER_ANGELS_LO_USD = 100_000;
    uint256 internal constant TIER_ANGELS_HI_USD = 333_000;
    uint256 internal constant TIER_ARCHANGELS_LO_USD = 333_000;
    uint256 internal constant TIER_ARCHANGELS_HI_USD = 777_000;
    uint256 internal constant TIER_HEAVENLY_HOST_LO_USD = 777_000;
    uint256 internal constant TIER_HEAVENLY_HOST_HI_USD = 1_200_000;
    uint256 internal constant TIER_MORNING_STARS_LO_USD = 1_200_000;
    uint256 internal constant TIER_MORNING_STARS_HI_USD = 3_300_000;
    uint256 internal constant TIER_VIRTUES_LO_USD = 3_300_000;
    uint256 internal constant TIER_VIRTUES_HI_USD = 7_700_000;
    uint256 internal constant TIER_DOMINIONS_LO_USD = 7_700_000;
    uint256 internal constant TIER_DOMINIONS_HI_USD = 33_000_000;
    uint256 internal constant TIER_THRONE_ROOM_LO_USD = 33_000_000;
    uint256 internal constant TIER_THRONE_ROOM_HI_USD = 77_000_000;
    uint256 internal constant TIER_CHERUBIM_LO_USD = 77_000_000;
    uint256 internal constant TIER_CHERUBIM_HI_USD = 120_000_000;
    uint256 internal constant TIER_SERAPHIM_LO_USD = 120_000_000;
    uint256 internal constant TIER_SERAPHIM_HI_USD = 777_000_000;
    uint256 internal constant TIER_AETHER_LO_USD = 777_000_000;
    uint256 internal constant TIER_AETHER_HI_USD = 1_200_000_000;
    uint256 internal constant TIER_EMPYREAN_LO_USD = 1_200_000_000;
    uint256 internal constant TIER_EMPYREAN_HI_USD = 3_300_000_000;
    uint256 internal constant TIER_SEVENTH_HEAVEN_LO_USD = 3_300_000_000;
    uint256 internal constant TIER_SEVENTH_HEAVEN_HI_USD = 7_770_000_000;

    // Legacy single-point aliases (tier lower bound / milestone)
    uint256 internal constant TIER_LAUNCH_PAD_USD = TIER_LAUNCH_PAD_LO_USD;
    uint256 internal constant TIER_LIMBO_USD = TIER_LIMBO_LO_USD;
    uint256 internal constant TIER_ASCENSION_USD = TIER_ASCENSION_LO_USD;
    uint256 internal constant TIER_NARROW_GATE_USD = TIER_NARROW_GATE_LO_USD;
    uint256 internal constant TIER_FIRMAMENT_USD = TIER_FIRMAMENT_LO_USD;
    uint256 internal constant TIER_ANGELS_USD = TIER_ANGELS_LO_USD;
    uint256 internal constant TIER_ARCHANGELS_USD = TIER_ARCHANGELS_LO_USD;
    uint256 internal constant TIER_HEAVENLY_HOST_USD = TIER_HEAVENLY_HOST_LO_USD;
    uint256 internal constant TIER_MORNING_STARS_USD = TIER_MORNING_STARS_LO_USD;
    uint256 internal constant TIER_VIRTUES_USD = TIER_VIRTUES_LO_USD;
    uint256 internal constant TIER_DOMINIONS_USD = TIER_DOMINIONS_LO_USD;
    uint256 internal constant TIER_THRONE_ROOM_USD = TIER_THRONE_ROOM_LO_USD;
    uint256 internal constant TIER_CHERUBIM_USD = TIER_CHERUBIM_LO_USD;
    uint256 internal constant TIER_SERAPHIM_USD = TIER_SERAPHIM_LO_USD;
    uint256 internal constant TIER_AETHER_USD = TIER_AETHER_LO_USD;
    uint256 internal constant TIER_EMPYREAN_USD = TIER_EMPYREAN_LO_USD;
    uint256 internal constant TIER_SEVENTH_HEAVEN_USD = TIER_SEVENTH_HEAVEN_HI_USD;

    // ── Wallet cap on curve only (§2 / LOCKED #8) ────────────────────────────
    uint256 internal constant WALLET_CAP_BPS = 700; // 7% of total supply; no exemptions

    // ── Anti-snipe (§2 / LOCKED #9) ───────────────────────────────────────────
    uint256 internal constant ANTI_SNIPE_START_BPS = 7770; // 77.7%
    uint256 internal constant ANTI_SNIPE_END_BPS = 0; // 0% after 7s — protocol 1% only
    uint256 internal constant ANTI_SNIPE_DURATION = 7; // seconds
    /// @dev Anti-snipe tax split (LOCKED #9 rev. 2026-10-15): 70% community RewardsVault / 30% treasury.
    uint256 internal constant SNIPE_REWARDS_BPS = 7000;

    // ── Base trade fee + split (§3 / LOCKED #11) ──────────────────────────────
    /// @dev 1% protocol trade fee in basis points of notional.
    uint256 internal constant TRADE_FEE_BPS = 100; // 1%
    /// @dev Shares of the 1% fee (must sum to 100 = FEE_SHARE_DENOM).
    uint256 internal constant FEE_SHARE_CREATOR = 33;
    uint256 internal constant FEE_SHARE_LP_LOCK = 33;
    uint256 internal constant FEE_SHARE_TREASURY = 33;
    uint256 internal constant FEE_SHARE_REFERRAL = 1;
    uint256 internal constant FEE_SHARE_DENOM = 100;

    // ── Creator tax (§3 / LOCKED #12) ─────────────────────────────────────────
    uint256 internal constant CREATOR_TAX_DEFAULT_BPS = 0;
    uint256 internal constant CREATOR_TAX_MAX_BPS = 700; // ≤7%, immutable at launch

    // ── KOL / referral economics (§4 / LOCKED #20–#21) ────────────────────────
    /// @dev Leftover 1% of trade fee → referrer (already FEE_SHARE_REFERRAL).
    /// @dev On coins created by referred wallet: 3% of creator fees =
    ///      leftover 1% of fee + 2% of creator's 33% share.
    uint256 internal constant KOL_CREATOR_FEE_SHARE_BPS = 200; // 2% of creator's 33% share
    uint256 internal constant KOL_OF_CREATOR_FEES_BPS = 300; // 3% of creator fees (composed)

    // ── Referral gate (§4 / LOCKED #18) ───────────────────────────────────────
    uint256 internal constant REFERRAL_USDG_GATE = 10 * 1e18; // $10 USDG deposit

    // ── Creator buy at launch (§5 / LOCKED #27) ───────────────────────────────
    uint256 internal constant CREATOR_BUY_MAX_BPS = 77; // 0.77% of supply

    // ── BPS helper ───────────────────────────────────────────────────────────
    uint256 internal constant BPS_DENOM = 10_000;
}

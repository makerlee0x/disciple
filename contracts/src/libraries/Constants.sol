// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DISCIPLE protocol constants
/// @notice Named constants locked in protocol-constitution.md (v0 / Robinhood Chain).
/// @dev Section references point at ../protocol-constitution.md
library Constants {
    // ── Supply (§2 Curve parameters / LOCKED #7) ─────────────────────────────
    uint8 internal constant TOKEN_DECIMALS = 18;
    uint256 internal constant TOTAL_SUPPLY = 7_000_000_000 * 1e18; // 7B fixed
    /// @dev ~72% of supply sold on the bonding curve before graduation (Outer Space, $33K).
    uint256 internal constant CURVE_SOLD_BPS = 7200; // 72.00%

    // ── Curve market caps (§2 / LOCKED #6, §9 Tier Ladder) — LOCKED 2026-10-15 ─
    /// @dev Launch Pad start market cap (USD, 18-dec fixed-point for quote pricing).
    uint256 internal constant START_MCAP_USD = 7_000 * 1e18; // $7K
    /// @dev Graduation market cap (opens the Outer Space tier).
    uint256 internal constant GRADUATION_MCAP_USD = 33_000 * 1e18; // $33K
    /// @dev Alias for GRADUATION_MCAP_USD.
    uint256 internal constant OUTER_SPACE_MCAP_USD = GRADUATION_MCAP_USD;

    // Tier ladder ranges (USD, whole dollars). Official ladder (disciple-brand/LEXICON.md §4, web/lib/flight/tiers.ts),
    // renamed 2026-10-17; ranges unchanged since LOCKED 2026-10-15. Pre-grad evenly spaced $7K→$33K (OUTER SPACE =
    // graduation); post-grad roughly geometric to Seventh Heaven. Altitude.tierOf uses the same lows (index 0..17).
    uint256 internal constant TIER_LAUNCH_PAD_LO_USD = 7_000;
    uint256 internal constant TIER_LAUNCH_PAD_HI_USD = 12_000;
    uint256 internal constant TIER_OZONE_LO_USD = 12_000;
    uint256 internal constant TIER_OZONE_HI_USD = 18_000;
    uint256 internal constant TIER_STRATOSPHERE_LO_USD = 18_000;
    uint256 internal constant TIER_STRATOSPHERE_HI_USD = 25_000;
    uint256 internal constant TIER_KARMAN_LINE_LO_USD = 25_000;
    uint256 internal constant TIER_KARMAN_LINE_HI_USD = 33_000;
    uint256 internal constant TIER_OUTER_SPACE_LO_USD = 33_000;
    uint256 internal constant TIER_OUTER_SPACE_HI_USD = 55_000;
    uint256 internal constant TIER_FIRMAMENT_LO_USD = 55_000;
    uint256 internal constant TIER_FIRMAMENT_HI_USD = 100_000;
    uint256 internal constant TIER_MORNING_STARS_LO_USD = 100_000;
    uint256 internal constant TIER_MORNING_STARS_HI_USD = 333_000;
    uint256 internal constant TIER_HEAVENLY_HOST_LO_USD = 333_000;
    uint256 internal constant TIER_HEAVENLY_HOST_HI_USD = 777_000;
    uint256 internal constant TIER_THE_MOON_LO_USD = 777_000;
    uint256 internal constant TIER_THE_MOON_HI_USD = 1_200_000;
    uint256 internal constant TIER_URANUS_LO_USD = 1_200_000;
    uint256 internal constant TIER_URANUS_HI_USD = 3_300_000;
    uint256 internal constant TIER_LIMBO_LO_USD = 3_300_000;
    uint256 internal constant TIER_LIMBO_HI_USD = 7_700_000;
    uint256 internal constant TIER_GATES_OF_HEAVEN_LO_USD = 7_700_000;
    uint256 internal constant TIER_GATES_OF_HEAVEN_HI_USD = 33_000_000;
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

    // Single-point aliases (tier lower bound / milestone)
    uint256 internal constant TIER_LAUNCH_PAD_USD = TIER_LAUNCH_PAD_LO_USD;
    uint256 internal constant TIER_OZONE_USD = TIER_OZONE_LO_USD;
    uint256 internal constant TIER_STRATOSPHERE_USD = TIER_STRATOSPHERE_LO_USD;
    uint256 internal constant TIER_KARMAN_LINE_USD = TIER_KARMAN_LINE_LO_USD;
    uint256 internal constant TIER_OUTER_SPACE_USD = TIER_OUTER_SPACE_LO_USD;
    uint256 internal constant TIER_FIRMAMENT_USD = TIER_FIRMAMENT_LO_USD;
    uint256 internal constant TIER_MORNING_STARS_USD = TIER_MORNING_STARS_LO_USD;
    uint256 internal constant TIER_HEAVENLY_HOST_USD = TIER_HEAVENLY_HOST_LO_USD;
    uint256 internal constant TIER_THE_MOON_USD = TIER_THE_MOON_LO_USD;
    uint256 internal constant TIER_URANUS_USD = TIER_URANUS_LO_USD;
    uint256 internal constant TIER_LIMBO_USD = TIER_LIMBO_LO_USD;
    uint256 internal constant TIER_GATES_OF_HEAVEN_USD = TIER_GATES_OF_HEAVEN_LO_USD;
    uint256 internal constant TIER_THRONE_ROOM_USD = TIER_THRONE_ROOM_LO_USD;
    uint256 internal constant TIER_CHERUBIM_USD = TIER_CHERUBIM_LO_USD;
    uint256 internal constant TIER_SERAPHIM_USD = TIER_SERAPHIM_LO_USD;
    uint256 internal constant TIER_AETHER_USD = TIER_AETHER_LO_USD;
    uint256 internal constant TIER_EMPYREAN_USD = TIER_EMPYREAN_LO_USD;
    uint256 internal constant TIER_SEVENTH_HEAVEN_USD = TIER_SEVENTH_HEAVEN_HI_USD;

    // ── Wallet cap on curve only (§2 / LOCKED #8) ────────────────────────────
    /// @dev Legacy 7% reference value (v1–v3 curves). The live cap is Launchpad.walletCapBps (default 0 = no cap).
    uint256 internal constant WALLET_CAP_BPS = 700;
    uint256 internal constant WALLET_CAP_BPS_DEFAULT = 0;

    // ── Sniper tax (§2 / LOCKED #9, mode rules v2 2026-10-23) — ALL modes, curve buys only ──
    /// @dev 99% → 0% linearly over 60s from launch. The creator's First BOOST is exempt. Taken in the pair coin and
    ///      held in the curve's `snipeEscrow` (outside reserves/price): added to the locked LP at graduation, or
    ///      released to RewardsVault by anyone if the coin has not graduated SNIPE_ESCROW_TIMEOUT after launch.
    uint256 internal constant ANTI_SNIPE_START_BPS = 9900; // 99%
    uint256 internal constant ANTI_SNIPE_END_BPS = 0; // 0% after 60s — protocol 1% only
    uint256 internal constant ANTI_SNIPE_DURATION = 60; // seconds
    /// @dev Unclaimed-escrow timeout DEFAULT. Maker lee 2026-10-23: 30 days → RewardsVault. Tunable by the protocol
    ///      owner for FUTURE launches (`Launchpad.setSnipeEscrowTimeout`, bounds below), snapshotted per curve.
    uint256 internal constant SNIPE_ESCROW_TIMEOUT = 30 days;
    uint256 internal constant SNIPE_ESCROW_TIMEOUT_MIN = 1 days;
    uint256 internal constant SNIPE_ESCROW_TIMEOUT_MAX = 365 days;
    /// @dev Legacy 70/30 FeeRouter snipe split (pre-v2 curves). v2 curves never route a snipe fee through FeeRouter.
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
    /// @dev Whole USD; contracts scale it by the USDG token's decimals at construction (immutable), so the
    ///      18-dec testnet mock and 6-dec mainnet USDG both gate at $10. See ReferralRegistry.usdgGate /
    ///      UsdgDepositNotifier.minDeposit.
    uint256 internal constant REFERRAL_GATE_USD = 10; // $10 USDG deposit

    // ── Creator buy at launch (§5 / LOCKED #27) ───────────────────────────────
    /// @dev Default protocol-owner-settable creator-buy cap (Launchpad.creatorBuyMaxBps) — 0.77% of supply.
    uint256 internal constant CREATOR_BUY_MAX_BPS_DEFAULT = 77;
    /// @dev Hard ceiling for Launchpad.creatorBuyMaxBps — 7% of supply.
    uint256 internal constant CREATOR_BUY_MAX_BPS_CEILING = 700;

    // ── BPS helper ───────────────────────────────────────────────────────────
    uint256 internal constant BPS_DENOM = 10_000;

    // ── Bonding-curve game modes (contracts/docs/bonding-modes.md) — curve only, never post-graduation ──
    uint8 internal constant MODE_TRENCH = 0; // no mode caps (legacy walletCapBps only); sniper tax applies
    uint8 internal constant MODE_PVE = 1; // Easy
    uint8 internal constant MODE_PVP = 2; // Hard
    // Mode rules v2 (Maker lee 2026-10-23). All curve-only; everything switches off at graduation.
    // Holding cap = NET curve position, linear in mcap progress START_MCAP_USD ($7K) → GRADUATION_MCAP_USD ($33K).
    // A buy above the wallet's room partially fills (unused input refunded); no max buy, no max sell, no window.
    uint256 internal constant PVE_CAP_START_BPS = 100; // Easy: 1% at $7K
    uint256 internal constant PVE_CAP_END_BPS = 333; // Easy: 3.33% at $33K
    uint256 internal constant PVP_CAP_START_BPS = 333; // Hard: 3.33% at $7K
    uint256 internal constant PVP_CAP_END_BPS = 777; // Hard: 7.77% at $33K
    /// @dev First BOOST (creator launch buy) max per mode. TRENCH keeps Launchpad.creatorBuyMaxBps (owner-settable).
    ///      The First BOOST is exempt from the holding cap for that buy only (it still counts in NET afterwards).
    uint256 internal constant FIRST_BOOST_MAX_BPS_PVE = 120; // 1.2%
    uint256 internal constant FIRST_BOOST_MAX_BPS_PVP = 333; // 3.33%
    /// @dev Easy crew tip: 0.777% of the sell proceeds, only when realized profit on that sale > threshold.
    uint256 internal constant PVE_CREW_TIP_PPM = 7770;
    /// @dev Crew-tip threshold, bps of the coin's market cap at the time of sale (Launchpad.crewTipThresholdBps,
    ///      owner-settable within [MIN, MAX], snapshotted per coin at launch). Default 0.5% of mcap.
    uint256 internal constant CREW_TIP_THRESHOLD_BPS_DEFAULT = 50;
    uint256 internal constant CREW_TIP_THRESHOLD_BPS_MIN = 10; // 0.1%
    uint256 internal constant CREW_TIP_THRESHOLD_BPS_MAX = 500; // 5%
    /// @dev Max age of a curve's cached LoginGate expiry (audit L1): a revoke takes effect within this window.
    uint256 internal constant PVE_LOGIN_CACHE_TTL = 10 minutes;
}

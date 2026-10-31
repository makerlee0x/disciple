// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Defaults for Disciple (`DiscipleHook`)
/// @notice One immutable hook, many coin/USDG pools. Nothing here is an admin knob.
///         Reasoning for each value lives in `../DESIGN.md`.
library BridgeConstants {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e36;
    uint256 internal constant BPS = 10_000;

    /// @dev Reference only. The hook does not special-case this address.
    address internal constant JESUS = 0x777A8DD86f0E29A28DAcf548Aebf42BB484daBBa;

    /// @dev Morpho Steakhouse USDG (ERC-4626) on Robinhood Chain. Passed into the constructor at deploy;
    ///      tests substitute a mock. Not read from this constant at runtime so the hook stays chain-agnostic.
    address internal constant MORPHO_STEAKHOUSE_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;

    // ── Fees ────────────────────────────────────────────────────────────────
    /// @dev 2% while the pool is tiny. This is the fee, not a ceiling on some other fee.
    uint256 internal constant FEE_TINY_BPS = 200;
    /// @dev 0.3% once pool TVL reaches the live graduation target (12% of smoothed reference TVL).
    uint256 internal constant FEE_GRAD_BPS = 30;
    uint256 internal constant FEE_FLOOR_BPS = FEE_GRAD_BPS;
    /// @dev ln(2) in WAD. Used to smooth the reference TVL. Not a fee input.
    uint256 internal constant LN2_WAD = 693_147_180_559_945_309;

    // ── Stale anchor ────────────────────────────────────────────────────────
    /// @dev The anchor is a 30-minute TWAP. Cross-chain, a stored quote older than this is stale.
    ///      Same-chain reads the window directly and is never stale. Staleness pays the keeper tip.
    ///      It does not change the swap fee.
    uint256 internal constant TWAP_WINDOW = 30 minutes;
    uint256 internal constant STALE_AFTER = TWAP_WINDOW;

    /// @dev Chosen once per pool.
    ///      0 lzRead of `IEthAnchor.latest`. 1 same-chain v3 `observe`.
    ///      2 same-chain v4 hook `consult`. 3 same-chain v4 slot0 ring kept by this hook.
    ///      4 lzRead of a remote v4 `consult`. 5 lzRead of a remote v4 slot0, sampled into the local ring.
    uint8 internal constant ANCHOR_LZ = 0;
    uint8 internal constant ANCHOR_V3 = 1;
    uint8 internal constant ANCHOR_V4_ORACLE = 2;
    uint8 internal constant ANCHOR_V4_SAMPLE = 3;
    uint8 internal constant ANCHOR_LZ_V4_ORACLE = 4;
    uint8 internal constant ANCHOR_LZ_V4_SLOT = 5;

    // ── Keeper tip ──────────────────────────────────────────────────────────
    /// @dev $1 of normalized USDG. Paid only when an update was actually stale (or the first read).
    uint256 internal constant TIP_USDG = 1e18;
    /// @dev Slice of each trade fee escrowed for keepers, until the budget cap.
    uint256 internal constant TIP_SLICE_BPS = 1_000; // 10% of the fee
    uint256 internal constant TIP_BUDGET_CAP = 10e18; // $10

    // ── LP boost (fee weight only) ──────────────────────────────────────────
    uint256 internal constant BOOST_START_WAD = 5e18; // 5x at launch, fee weight only
    uint256 internal constant BOOST_END_WAD = 12e17; // 1.2x, reached at graduation TVL and then stuck

    // ── Price band ──────────────────────────────────────────────────────────
    /// @dev Full-pool move at or below BAND_TINY_TVL. Trading the whole book moves spot about 25%.
    uint256 internal constant BAND_START_WAD = 0.25e18;
    /// @dev Full-pool move once TVL reaches the pool's own graduation target. About ±3.33%.
    uint256 internal constant BAND_END_WAD = 0.0333e18;
    /// @dev "Tiny". At or below this TVL the band stays at BAND_START. The $77 seed is under it.
    uint256 internal constant BAND_TINY_TVL = 100e18;

    // ── Graduation / creator / Morpho ───────────────────────────────────────
    uint256 internal constant GRAD_NUM = 12;
    uint256 internal constant GRAD_DEN = 100;
    uint256 internal constant CREATOR_FEE_BPS = 1_000; // 10% of LP fees, only after graduation
    uint256 internal constant BUFFER_MIN = 500e18; // $500 trading buffer kept out of Morpho
    uint256 internal constant BUFFER_TVL_BPS = 500; // or 5% of TVL, whichever is larger
    /// @dev Recommended cap on the share of USDG principal that may sit in the ERC-4626 vault.
    ///      100% disables the extra cap (the floor and the trading buffer still apply). Creators set this.
    uint16 internal constant MORPHO_CAP_BPS = 5_000;
    /// @dev Public wait before a vault admin's replacement vault can be executed.
    uint256 internal constant VAULT_TIMELOCK = 48 hours;
    /// @dev Continuous time on one side of the live target before status flips. The same wait
    ///      turns it on (pool TVL at or above the target) and off (pool TVL strictly below it).
    ///      There is no percent band. Depth, fee, boost, and Dutch size do not wait on it.
    uint256 internal constant GRADUATION_WINDOW = 77 minutes;

    // ── Dutch quotes ────────────────────────────────────────────────────────
    /// @dev Wad of gap per second. 0 at creation selects the default, about 1% of the anchor per hour.
    ///      Allowed range is about 0.1% to 10% of the anchor per hour. Fixed for the life of the pool.
    ///      Integer division, so an hour of the default is 2800 wei under 0.01e18.
    uint256 internal constant DUTCH_DRIFT_DEFAULT = uint256(0.01e18) / 1 hours;
    uint256 internal constant DUTCH_DRIFT_MIN = uint256(0.001e18) / 1 hours;
    uint256 internal constant DUTCH_DRIFT_MAX = uint256(0.1e18) / 1 hours;
    /// @dev USDG offered at a gap of 1.0 (100% of the anchor), before the slice cap. Size = edge / gap.
    uint256 internal constant DUTCH_EDGE_WAD = 0.25e18;
    /// @dev One taker cannot buy or sell more than this much USDG of the drifted quote, before
    ///      progress scales the cap down.
    uint256 internal constant DUTCH_MAX_SLICE = 50e18;
    /// @dev And not more than 5% of pool TVL. The cap is at least $1, so a tiny pool still quotes.
    uint256 internal constant DUTCH_MIN_SLICE = 1e18;
    /// @dev Share of the safety cap still offered at 100% progress. The rest closes linearly with
    ///      `poolTVL / gradTvl` and reopens when the live target rises.
    uint256 internal constant DUTCH_PROGRESS_FLOOR_WAD = 0.2e18;
    /// @dev The ask price stops at 1% of the anchor. The size keeps using the raw gap, so it still shrinks.
    uint256 internal constant DUTCH_ASK_CAP = 0.99e18;

    // ── Curve shape ─────────────────────────────────────────────────────────
    /// @dev Recommended launch discount. 33% below the anchor = 0.67x. Creators pass this explicitly.
    uint16 internal constant DISCOUNT_BPS = 3_300;
    /// @dev Recommended USDG floor. Creators pass this explicitly (allowed 1%–50%).
    uint16 internal constant FLOOR_BPS = 2_000;
    /// @dev The last half of the original seed cannot be bought while the marginal price is below the anchor.
    uint256 internal constant SEED_FLOOR_BPS = 5_000;
    /// @dev g^30 tail strength. At f = 1 the extra cost is about TAIL_K/31 of the CP cost (~26% when TAIL_K = 8).
    uint256 internal constant TAIL_K = 8e18;

    uint256 internal constant SHARE_OFFSET = 1e6;
    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant MAX_NEWTON = 96;

    /// @dev Per-pool outflow window sentinels. 0 = off, 1 = per block, 3600 = per hour. Anything else is rejected.
    uint32 internal constant OUTFLOW_PER_BLOCK = 1;
    uint32 internal constant OUTFLOW_PER_HOUR = 3600;
}

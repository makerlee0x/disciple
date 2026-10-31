// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Defaults for the DISCIPLE Bridge Launch Hook (v1)
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
    /// @dev 2% while the pool is tiny.
    uint256 internal constant FEE_TINY_BPS = 200;
    /// @dev 0.3% once pool TVL reaches the graduation threshold (12% of the Ethereum pool).
    uint256 internal constant FEE_GRAD_BPS = 30;
    /// @dev Hard cap after the staleness multiplier, so a dead oracle cannot turn the pool into a honeypot.
    uint256 internal constant FEE_ABS_CAP_BPS = 2_000;
    /// @dev Trades that close the gap to the anchor pay half the base fee; trades that open it pay 1.5x.

    // ── Stale anchor ────────────────────────────────────────────────────────
    /// @dev The anchor is a 30-minute TWAP. Cross-chain, a stored quote older than this is stale.
    ///      Same-chain reads the window directly and is never stale.
    uint256 internal constant TWAP_WINDOW = 30 minutes;
    uint256 internal constant STALE_AFTER = TWAP_WINDOW;

    /// @dev Chosen once per pool. 0 = LayerZero lzRead. 1 = same-chain Uniswap v3 `observe`.
    uint8 internal constant ANCHOR_LZ = 0;
    uint8 internal constant ANCHOR_V3 = 1;
    /// @dev Linear ramp from 1x to STALE_MAX_MULT over the two hours after STALE_AFTER.
    uint256 internal constant STALE_RAMP = 2 hours;
    uint256 internal constant STALE_MAX_MULT = 5;

    // ── Keeper tip ──────────────────────────────────────────────────────────
    /// @dev $1 of normalized USDG. Paid only when an update was actually stale (or the first read).
    uint256 internal constant TIP_USDG = 1e18;
    /// @dev Slice of each trade fee escrowed for keepers, until the budget cap.
    uint256 internal constant TIP_SLICE_BPS = 1_000; // 10% of the fee
    uint256 internal constant TIP_BUDGET_CAP = 10e18; // $10

    // ── LP boost (fee weight only) ──────────────────────────────────────────
    uint256 internal constant BOOST_START_WAD = 33e17; // 3.3x
    uint256 internal constant BOOST_END_WAD = 12e17; // 1.2x
    /// @dev TVL at which the curve is flat (±3.33%) and the boost has finished decaying.
    uint256 internal constant FLAT_TVL = 10_000e18;
    /// @dev Half-band at the flat TVL: 3.33% = 333 / 10_000.
    uint256 internal constant BAND_WAD = 333e14; // 0.0333e18

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

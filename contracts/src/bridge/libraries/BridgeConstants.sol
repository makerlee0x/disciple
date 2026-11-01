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

    // ── Fees ────────────────────────────────────────────────────────────────
    /// @dev 2% while the pool is tiny. This is the fee, not a ceiling on some other fee.
    uint256 internal constant FEE_TINY_BPS = 200;
    /// @dev 0.3% once pool TVL reaches the live graduation target (12% of smoothed reference TVL).
    uint256 internal constant FEE_GRAD_BPS = 30;
    uint256 internal constant FEE_FLOOR_BPS = FEE_GRAD_BPS;
    /// @dev ln(2) in WAD. Used to smooth the reference TVL. Not a fee input.
    uint256 internal constant LN2_WAD = 693_147_180_559_945_309;
    /// @dev One smooth step closes at most this much of the half-life. A reading after idle time,
    ///      or one donation, cannot jump the stored TVL the rest of the way.
    uint256 internal constant SMOOTH_STEP = 10 minutes;
    // ── Stale anchor ────────────────────────────────────────────────────────
    /// @dev The anchor is a 30-minute TWAP. A stored quote older than this is stale for every kind.
    ///      Curve trades stop until a poke refreshes it. Redeems do not. Staleness does not change the fee.
    uint256 internal constant TWAP_WINDOW = 30 minutes;
    uint256 internal constant STALE_AFTER = TWAP_WINDOW;

    /// @dev Chosen once per pool. Same chain only.
    ///      0 Uniswap v2 pair, verified with `factory.getPair`, sampled into the ring.
    ///      1 Uniswap v3 pool, verified with `factory.getPool`, priced with `observe`.
    ///      2 Uniswap v4 pool, verified with `PoolKey.toId`, sampled into the ring.
    uint8 internal constant ANCHOR_V2 = 0;
    uint8 internal constant ANCHOR_V3 = 1;
    uint8 internal constant ANCHOR_V4 = 2;

    // ── LP boost (fee weight only) ──────────────────────────────────────────
    uint256 internal constant BOOST_START_WAD = 7e18; // 7x at launch, fee weight only
    uint256 internal constant BOOST_END_WAD = 12e17; // 1.2x, reached at graduation TVL and then stuck

    // ── Graduation / fee split ──────────────────────────────────────────────
    uint256 internal constant GRAD_NUM = 12;
    uint256 internal constant GRAD_DEN = 100;
    /// @dev Of a graduated fee. 3,333 creator + 3,333 locked, and the remainder (3,334) to LPs.
    ///      Before graduation the whole fee compounds for LPs. There is no builder share.
    uint256 internal constant FEE_CREATOR_BPS = 3_333;
    uint256 internal constant FEE_LOCKED_BPS = 3_333;
    /// @dev Status flips in the same call that crosses the live target. There is no time window.
    ///      Pool TVL for that check is every coin and USDG in the book, LP deposits included.

    // ── Dutch quotes ────────────────────────────────────────────────────────
    /// @dev Remaining gap is capped here so the ask `anchor * (1 - gap)` stays positive.
    ///      77% of the anchor, both sides.
    uint256 internal constant DUTCH_GAP_CAP = 0.77e18;
    /// @dev Linear gap per second. Integer division, so exactly 12 hours lands a few wei under the cap.
    uint256 internal constant DUTCH_RATE = uint256(0.77e18) / 12 hours;
    /// @dev Share of the price improvement versus the anchor, charged on top of the sliding fee
    ///      while the pool is not graduated. 7,700 bps is 77%, which is never more than the improvement.
    uint256 internal constant ARB_FEE_BPS = 7_700;

    // ── Reference quality ───────────────────────────────────────────────────
    /// @dev In-range (v3/v4) or whole-pool (v2) USDG value a source must show. Below this, create
    ///      reverts and a later read does not refresh the anchor.
    uint256 internal constant MIN_REF_TVL = 12_000e18;
    /// @dev v3 must `observe` this far back. v2 and v4 use a permissionless witness instead.
    uint256 internal constant MIN_REF_AGE = 7 days;
    /// @dev Asked of the v3 source at create so a 30-minute `observe` can succeed on 1-second blocks.
    uint16 internal constant V3_CARDINALITY_NEXT = 1800;

    // ── Curve shape ─────────────────────────────────────────────────────────
    /// @dev Launch discount. 33% below the anchor = 0.67x. The same for every pool. `CreateParams.discountBps` is ignored.
    uint16 internal constant DISCOUNT_BPS = 3_300;
    /// @dev The last half of the original seed cannot be bought while the marginal price is below the anchor.
    uint256 internal constant SEED_FLOOR_BPS = 5_000;
    /// @dev g^30 tail strength. At f = 1 the extra cost is about TAIL_K/31 of the CP cost (~26% when TAIL_K = 8).
    uint256 internal constant TAIL_K = 8e18;

    /// @dev Not read by the hook. Create ignores a passed floor, outflow, drift, and discount.
    ///      The names stay so older call sites still compile. Graduation does not wait, and there
    ///      is no price band and no Dutch slice.
    uint16 internal constant FLOOR_BPS = 2_000;
    uint256 internal constant GRADUATION_WINDOW = 77 minutes;
    uint32 internal constant OUTFLOW_PER_BLOCK = 1;
    uint32 internal constant OUTFLOW_PER_HOUR = 3600;
    uint16 internal constant OUTFLOW_CAP_DEFAULT_BPS = 2_000;
    uint256 internal constant DUTCH_DRIFT_DEFAULT = uint256(0.01e18) / 1 hours;
    uint256 internal constant DUTCH_DRIFT_MIN = uint256(0.001e18) / 1 hours;
    uint256 internal constant DUTCH_DRIFT_MAX = uint256(0.1e18) / 1 hours;
    uint256 internal constant DUTCH_MIN_SLICE = 1e18;
    uint256 internal constant BAND_START_WAD = 0.25e18;
    uint256 internal constant BAND_END_WAD = 0.0333e18;
    uint256 internal constant BAND_TINY_TVL = 100e18;
    uint16 internal constant MIN_V3_CARDINALITY = 2;

    uint256 internal constant SHARE_OFFSET = 1e6;
    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant MAX_NEWTON = 96;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";

/// @notice Retail is $5-$50, 50/50, a full $1,000/day. Arb is extra: it trades when the gap
///         exceeds the base fee plus 0.5%, sizing off the virtual book so it can actually close
///         a wide band. Graduation is 12% of a $721k reference pool ($86,520).
/// @dev The anchor is $1, so a normalized coin unit is one dollar of JESUS. The JESUS token
///      count for a $77 seed at $0.0000000136 is reported beside that.
contract BridgeLaunchSimTest is Test {
    uint256 internal constant ANCHOR = 1e18;
    uint256 internal constant SEED = 77e18;
    /// @dev 12% of $721,000.
    uint256 internal constant REF_TVL = 721_000e18;
    uint256 internal constant GRAD = (REF_TVL * 12) / 100;
    uint256 internal constant DAILY = 1_000e18;
    /// @dev $0.0000000136 as a WAD price.
    uint256 internal constant JESUS_PRICE_WAD = 13_600_000_000;

    BridgeCurve.S internal s;
    uint256 internal fees;
    int256 internal arbProfit;
    uint256 internal tipBudget;
    bool internal graduated;
    uint256 internal rng = 1;
    uint256 internal gapSum;
    uint256 internal gapN;
    uint256 internal arbNotional;

    function test_recommendedSeedIsAllCoin() public pure {
        BridgeCurve.S memory m;
        BridgeCurve.init(m, SEED, 0.33e18);
        BridgeCurve.onAnchor(m, ANCHOR);
        assertEq(m.x, SEED);
        assertEq(m.y, 0);
        assertEq(BridgeCurve.spot(m), 0.67e18);
        assertEq(GRAD, 86_520e18);
        // $77 / $0.0000000136 ≈ 5.6618e9 JESUS. WAD units, 18 decimals.
        uint256 jesus = Math.mulDiv(SEED, C.WAD, JESUS_PRICE_WAD);
        assertGt(jesus, 5.66e27);
        assertLt(jesus, 5.67e27);
    }

    function test_sim7Days() public {
        _reset();
        console2.log("SIM_GRAD", GRAD);
        console2.log("SIM_JESUS_TOKENS_WAD", Math.mulDiv(SEED, C.WAD, JESUS_PRICE_WAD));
        _run(7, true);
        assertGt(s.x, 0);
        assertGt(s.y, 0, "the week left real USDG in the pool");
        assertGt(fees, 1e18);
        assertGt(arbNotional, 0, "arb traded during the week");
        assertGt(gapN, 0);
        uint256 avgGap = gapSum / gapN;
        assertGt(avgGap, 0.012e18, "pre-arb gaps stay wider than the old 1.2% settle");
        assertLt(BridgeCurve.tvl(s), GRAD, "a $1k/day week does not graduate");
        _logSummary("SIM7");
    }

    function test_sim90Days() public {
        _reset();
        _run(90, false);
        _logSummary("SIM90");
        assertGt(gapN, 0);
        assertLt(BridgeCurve.tvl(s), GRAD, "$1k/day for 90 days does not reach $86.5k");
    }

    /// @dev Keep going until graduation or a year, whichever comes first.
    function test_simUntilGraduationOrYear() public {
        _reset();
        uint256 day = _run(365, false);
        _logSummary("SIM365");
        console2.log("SIM_STOPPED_DAY", day);
        console2.log("SIM_GRADUATED", graduated ? uint256(1) : uint256(0));
    }

    function _reset() internal {
        BridgeCurve.S memory m;
        BridgeCurve.init(m, SEED, 0.33e18);
        BridgeCurve.onAnchor(m, ANCHOR);
        s = m;
        fees = 0;
        arbProfit = 0;
        tipBudget = 0;
        graduated = false;
        rng = 1;
        gapSum = 0;
        gapN = 0;
        arbNotional = 0;
    }

    /// @return day The last day that ran.
    function _run(uint256 days_, bool daily) internal returns (uint256 day) {
        uint256 weekGap;
        uint256 weekN;
        uint256 weekArb;
        uint256 weekFees;
        for (day = 1; day <= days_; ++day) {
            uint256 feesBefore = fees;
            uint256 arbBefore = arbNotional;
            uint256 gapBefore = gapSum;
            uint256 nBefore = gapN;
            uint256 vol;
            uint256 guard;
            while (vol < DAILY && guard < 500) {
                unchecked {
                    ++guard;
                }
                uint256 amt = 5e18 + (_rnd() % (45e18 + 1));
                if (vol + amt > DAILY) amt = DAILY - vol;
                bool buy = _rnd() % 2 == 0;
                if (!buy && s.y < 1e18) buy = true;
                if (buy) _applyBuy(amt, false);
                else _applySell(Math.mulDiv(amt, C.WAD, _spot() == 0 ? ANCHOR : _spot()), false);
                vol += amt;
                _recordGap();
                arbNotional += _arb();
            }
            if (BridgeCurve.tvl(s) >= GRAD) graduated = true;
            weekGap += gapSum - gapBefore;
            weekN += gapN - nBefore;
            weekArb += arbNotional - arbBefore;
            weekFees += fees - feesBefore;
            bool boundary = daily || day % 7 == 0 || day == days_ || graduated;
            if (boundary) {
                uint256 avg = weekN == 0 ? 0 : weekGap / weekN;
                console2.log("SIM_DAY", day);
                console2.log("SIM_TVL", BridgeCurve.tvl(s));
                console2.log("SIM_PRICE", _spot());
                console2.log("SIM_COIN", s.x);
                console2.log("SIM_USDG", s.y);
                console2.log("SIM_GAP_WAD", avg);
                console2.log("SIM_ARB_WEEK", weekArb);
                console2.log("SIM_FEES_WEEK", weekFees);
                console2.log("SIM_BAND_WAD", BridgeCurve.bandWad(BridgeCurve.tvl(s), GRAD));
                weekGap = 0;
                weekN = 0;
                weekArb = 0;
                weekFees = 0;
            }
            if (graduated) return day;
        }
        return days_;
    }

    function _logSummary(string memory tag) internal view {
        uint256 avg = gapN == 0 ? 0 : gapSum / gapN;
        console2.log(tag);
        console2.log("SIM_SAMPLES", gapN);
        console2.log("SIM_AVG_GAP_WAD", avg);
        console2.log("SIM_ARB_TOTAL", arbNotional);
        console2.log("SIM_FEES_TOTAL", fees);
        console2.log("SIM_TVL", BridgeCurve.tvl(s));
        console2.log("SIM_PRICE", _spot());
        console2.log("SIM_ARB_MARK", arbProfit);
    }

    function _recordGap() internal {
        uint256 p = _spot();
        if (p == 0) return;
        uint256 gap = p > ANCHOR ? p - ANCHOR : ANCHOR - p;
        gapSum += Math.mulDiv(gap, C.WAD, ANCHOR);
        gapN += 1;
    }

    function _arb() internal returns (uint256 added) {
        for (uint256 i; i < 16; ++i) {
            uint256 p = _spot();
            if (p == 0) break;
            uint256 bps = BridgeFee.baseFeeBps(BridgeCurve.tvl(s), GRAD);
            uint256 slack = bps * 1e14 + 0.005e18;
            if (slack >= C.WAD) break;
            uint256 buyLine = Math.mulDiv(ANCHOR, C.WAD - slack, C.WAD);
            uint256 sellLine = ANCHOR + Math.mulDiv(ANCHOR, slack, C.WAD);
            uint256 yEff = s.y + s.vy;
            if (yEff == 0) break;
            if (p < buyLine) {
                uint256 raw = Math.mulDiv(ANCHOR - p, yEff, p) / 2;
                uint256 a = _clamp(raw, 1e18, 5_000e18);
                uint256 filled = _applyBuy(a, true);
                if (filled == 0) break;
                added += filled;
            } else if (p > sellLine && s.y > 1e18) {
                uint256 raw = Math.mulDiv(p - ANCHOR, yEff, p) / 2;
                uint256 usd = _clamp(raw, 1e18, 5_000e18);
                uint256 dx = Math.mulDiv(usd, C.WAD, p);
                if (dx == 0) break;
                uint256 filled = _applySell(dx, true);
                if (filled == 0) break;
                added += filled;
            } else {
                break;
            }
        }
    }

    function _applyBuy(uint256 usdgIn, bool arb) internal returns (uint256 filled) {
        BridgeCurve.S memory m = s;
        BridgeCurve.Fill memory f;
        (m, f) = BridgeCurve.buyExactIn(m, usdgIn, _ctx(m));
        if (f.coinOut == 0) return 0;
        s = m;
        _book(f.fee, f.tip);
        if (arb) arbProfit += int256(Math.mulDiv(f.coinOut, ANCHOR, C.WAD)) - int256(f.usdgIn);
        return f.usdgIn;
    }

    function _applySell(uint256 dx, bool arb) internal returns (uint256 filled) {
        if (dx == 0) return 0;
        BridgeCurve.S memory m = s;
        BridgeCurve.Ctx memory c = _ctx(m);
        c.maxUsdgOut = BridgeCurve.floorRoom(m, c.floorBps);
        BridgeCurve.Fill memory f;
        (m, f) = BridgeCurve.sellExactIn(m, dx, c);
        if (f.usdgOut == 0 && f.coinIn == 0) return 0;
        s = m;
        _book(f.fee, f.tip);
        if (arb && f.coinIn > 0) {
            arbProfit += int256(f.usdgOut) - int256(Math.mulDiv(f.coinIn, ANCHOR, C.WAD));
        }
        return f.usdgOut;
    }

    function _book(uint256 fee, uint256 tip) internal {
        fees += fee;
        tipBudget += tip;
        if (tipBudget > C.TIP_BUDGET_CAP) tipBudget = C.TIP_BUDGET_CAP;
    }

    function _ctx(BridgeCurve.S memory m) internal view returns (BridgeCurve.Ctx memory c) {
        c.gradTvl = GRAD;
        c.floorBps = C.FLOOR_BPS;
        c.maxUsdgOut = type(uint256).max;
        c.boostWad = BridgeFee.boostWad(BridgeCurve.tvl(m), GRAD);
        c.tipRoom = tipBudget >= C.TIP_BUDGET_CAP ? 0 : C.TIP_BUDGET_CAP - tipBudget;
        c.graduated = graduated;
    }

    function _spot() internal view returns (uint256) {
        return BridgeCurve.spot(s);
    }

    function _rnd() internal returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng)));
        return rng;
    }

    function _clamp(uint256 v, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }
}

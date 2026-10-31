// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";

/// @notice Port of sim7.py onto BridgeCurve / BridgeFee.
///         Retail is $5-$50, 50/50, $1,000/day, 7 days. Arb closes a gap wider than the base fee + 0.5%.
///         The python model slid the fee to 0.3% by $10k. This one uses the real schedule: 0.3% at graduation,
///         which for JESUS is 12% of a $725k Ethereum pool ($87k). A $77 book does not get there in a week.
/// @dev Oversized sells are cut to the floor quote, which is what a router does. A raw v4 swap of the
///      uncapped size reverts instead; see DESIGN.md.
contract BridgeLaunchSimTest is Test {
    uint256 internal constant ANCHOR = 1e18;
    uint256 internal constant SEED = 77e18;
    uint256 internal constant GRAD = 87_000e18;
    uint256 internal constant DAILY = 1_000e18;

    BridgeCurve.S internal s;
    uint256 internal fees;
    int256 internal arbProfit;
    uint256 internal tipBudget;
    bool internal graduated;
    uint256 internal rng = 1;

    function test_recommendedSeedIsAllCoin() public pure {
        BridgeCurve.S memory m;
        BridgeCurve.init(m, SEED, 0.33e18);
        BridgeCurve.onAnchor(m, ANCHOR);
        assertEq(m.x, SEED);
        assertEq(m.y, 0);
        assertEq(BridgeCurve.spot(m), 0.67e18);
    }

    function test_sim7Days() public {
        BridgeCurve.S memory m;
        BridgeCurve.init(m, SEED, 0.33e18);
        BridgeCurve.onAnchor(m, ANCHOR);
        s = m;

        console2.log("SIM_SEED coin", SEED);
        console2.log("SIM_SEED usdg", uint256(0));
        console2.log("SIM_SEED split: 77e18 coin, 0 USDG. Virtual USDG sets 0.67x, so the $77 is all inventory.");
        console2.log("SIM_SEED tip: optional and separate from the $77. This run starts the keeper budget at 0.");

        for (uint256 day = 1; day <= 7; ++day) {
            uint256 vol;
            uint256 guard;
            while (vol < DAILY && guard < 400) {
                unchecked {
                    ++guard;
                }
                uint256 amt = 5e18 + (_rnd() % (45e18 + 1));
                bool buy = _rnd() % 2 == 0;
                if (!buy && s.y < 1e18) buy = true;
                if (buy) _applyBuy(amt, false);
                else _applySell(Math.mulDiv(amt, C.WAD, _spot()), false);
                vol += amt;
                vol += _arb();
                if (BridgeCurve.tvl(s) >= GRAD) graduated = true;
            }
            console2.log("SIM_DAY", day);
            console2.log("SIM_COIN", s.x);
            console2.log("SIM_USDG", s.y);
            console2.log("SIM_TVL", BridgeCurve.tvl(s));
            console2.log("SIM_PRICE", _spot());
            console2.log("SIM_FEES", fees);
            console2.log("SIM_ARB", arbProfit);
        }
        assertGt(s.x, SEED / 2, "half the seed is still inventory");
        assertGt(s.y, 10e18, "the week left real USDG in the pool");
        assertApproxEqRel(_spot(), ANCHOR, 0.05e18, "arb keeps the quote near the anchor");
        assertGt(fees, 50e18);
        assertLt(BridgeCurve.tvl(s), GRAD, "a $1k/day week does not graduate a JESUS-sized pool");
    }

    function _arb() internal returns (uint256 added) {
        for (uint256 i; i < 20; ++i) {
            uint256 p = _spot();
            if (p == 0) break;
            uint256 bps = BridgeFee.baseFeeBps(BridgeCurve.tvl(s), GRAD);
            uint256 slack = bps * 1e14 + 0.005e18;
            if (slack >= C.WAD) break;
            uint256 buyLine = Math.mulDiv(ANCHOR, C.WAD - slack, C.WAD);
            uint256 sellLine = ANCHOR + Math.mulDiv(ANCHOR, slack, C.WAD);
            if (p < buyLine) {
                uint256 raw = Math.mulDiv(ANCHOR - p, s.x, C.WAD) * 3 / 10;
                uint256 a = _clamp(raw, 1e18, 20e18);
                uint256 yBefore = s.y;
                _applyBuy(a, true);
                if (s.y == yBefore) break;
                added += a;
            } else if (p > sellLine && s.y > 1e18) {
                uint256 raw = Math.mulDiv(p - ANCHOR, s.x, C.WAD) * 3 / 10;
                uint256 usd = _clamp(raw, 1e18, 20e18);
                uint256 dx = Math.mulDiv(usd, C.WAD, p);
                uint256 yBefore = s.y;
                _applySell(dx, true);
                if (s.y == yBefore) break;
                added += usd;
            } else {
                break;
            }
        }
    }

    function _applyBuy(uint256 usdgIn, bool arb) internal {
        BridgeCurve.S memory m = s;
        BridgeCurve.Fill memory f;
        (m, f) = BridgeCurve.buyExactIn(m, usdgIn, _ctx(m));
        if (f.coinOut == 0) return;
        s = m;
        _book(f.fee, f.tip);
        if (arb) arbProfit += int256(Math.mulDiv(f.coinOut, ANCHOR, C.WAD)) - int256(f.usdgIn);
    }

    function _applySell(uint256 dx, bool arb) internal {
        if (dx == 0) return;
        BridgeCurve.S memory m = s;
        BridgeCurve.Ctx memory c = _ctx(m);
        c.maxUsdgOut = BridgeCurve.floorRoom(m, c.floorBps);
        BridgeCurve.Fill memory f;
        (m, f) = BridgeCurve.sellExactIn(m, dx, c);
        if (f.usdgOut == 0 && f.coinIn == 0) return;
        s = m;
        _book(f.fee, f.tip);
        if (arb && f.coinIn > 0) {
            arbProfit += int256(f.usdgOut) - int256(Math.mulDiv(f.coinIn, ANCHOR, C.WAD));
        }
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
        c.boostWad = BridgeFee.boostWad(BridgeCurve.tvl(m));
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

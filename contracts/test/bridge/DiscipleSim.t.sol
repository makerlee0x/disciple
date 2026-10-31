// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";

/// @notice Simulator only. Nothing in this file is part of the hook.
///
/// Every profile shares one retail stream and one oracle path. The oracle is a geometric
/// random walk of the JESUS price: 3% a day in the active scenario, 0.1% a day when the
/// coin is dead. Retail is $5–$50. Active days are $1,000. Dead days are $100–$200.
/// The walk and the daily budget use their own seeds, so a variant cannot knock the path
/// off the one the others see.
///
/// Two searchers are run as separate profiles. OUT pays the pool fee plus 0.5%. LOW pays
/// the pool fee plus gas, about 0.05%. LOW is a public searcher. The hook is generic, so
/// the launch team is not assumed to run it.
///
/// Modes:
///   0 rev fee, the book keeps its spot/anchor ratio when the oracle moves
///   BASE the pre-rev schedule (the sliding 2%→0.3% cap on every trade)
///   A–D overshoot / relist, on the rev-fee book
///   LEV  50/50 value mix. The quote is the oracle adjusted by the mix error times an
///        amplification that slides from 3x at launch to 1x at graduation, so an oracle
///        move of size r opens a gap of about 3r while the pool is small and about r
///        once it graduates. Only the trade that walks the mix back is rich.
///   DUTCH two independent quotes, bid and ask. Each drifts off the anchor at 1% per hour
///        and resets only when that side trades. There is no max gap. Size is
///        edge/gap, also capped at $50 and at 5% of TVL, so a late fill is a small slice
///        and never the pool. The bid price stops at 1% of the anchor so it stays
///        positive; past that the slice keeps shrinking. The tail, the seed guard, and
///        the 20% floor still bind inside every fill. Active and dead both use this.
///   DRIP once an hour, a dutch sale of JESUS funded only by fees. The coin has to be
///        surplus above the seed. The discount is sniped at the searcher's cost and the
///        subsidy cannot exceed fees already earned.
contract DiscipleSimTest is Test {
    uint256 internal constant START = 1e18;
    uint256 internal constant SEED = 77e18;
    uint256 internal constant REF_TVL = 721_000e18;
    uint256 internal constant GRAD = (REF_TVL * 12) / 100;
    uint256 internal constant DAILY_ACTIVE = 1_000e18;
    uint256 internal constant JESUS_PRICE_WAD = 13_600_000_000;
    uint256 internal constant COST_OUTSIDE = 0.005e18;
    uint256 internal constant COST_LOW = 0.0005e18;
    uint256 internal constant VOL_ACTIVE = 0.03e18;
    uint256 internal constant VOL_DEAD = 0.001e18;

    uint8 internal constant MODE_A = 1;
    uint8 internal constant MODE_B = 2;
    uint8 internal constant MODE_C = 3;
    uint8 internal constant MODE_D = 4;
    uint8 internal constant MODE_BASE = 5;
    uint8 internal constant MODE_LEV = 6;
    uint8 internal constant MODE_DUTCH = 7;
    uint8 internal constant MODE_DRIP = 8;
    uint8 internal constant ACT_RETAIL = 0;
    uint8 internal constant ACT_ARB = 1;
    uint8 internal constant ACT_LOOP = 2;

    uint256 internal constant FLIP_COOLDOWN = 10 * 12 seconds;
    uint256 internal constant OVERSHOOT_HALF = 5 minutes;
    /// @dev 1% of the anchor per hour. Integer division; the residual is under a wei per second.
    uint256 internal constant DUTCH_PER_SEC = uint256(0.01e18) / 1 hours;
    /// @dev Mark on one take is about this once the gap is wide enough that the $50 cap is not binding.
    uint256 internal constant DUTCH_EDGE = 0.25e18;
    uint256 internal constant DUTCH_MAX_SLICE = 50e18;
    uint256 internal constant AMP_START = 3e18;
    uint256 internal constant AMP_END = 1e18;

    struct Snap {
        BridgeCurve.S s;
        uint256 fees;
        int256 arbMark;
        int256 arbProfit;
        uint256 missed;
        uint256 tipBudget;
        uint256 arbNotional;
        uint256 grossNotional;
        uint256 revVolume;
        uint256 revAt;
        uint256 attackerHold;
        int256 loopMark;
        int256 loopProfit;
        uint256 loopNotional;
        uint256 overshootAt;
        int256 retailMark;
        uint256 dripBudget;
        uint256 dripSubsidy;
    }

    BridgeCurve.S internal s;
    uint256 internal fees;
    int256 internal arbMark;
    int256 internal arbProfit;
    uint256 internal missed;
    uint256 internal tipBudget;
    bool internal graduated;
    uint256 internal rng = 1;
    uint256 internal gapSum;
    uint256 internal gapN;
    uint256 internal arbNotional;
    uint256 internal grossNotional;
    uint256 internal clock;
    uint256 internal revVolume;
    uint256 internal revAt;
    uint256 internal costWad;
    uint8 internal mode;
    uint256 internal overshootAt;
    uint256 internal attackerHold;
    uint256 internal attackerNextBuy;
    uint256 internal attackerNextSell;
    uint256 internal arbNextBuy;
    uint256 internal arbNextSell;
    int256 internal loopMark;
    int256 internal loopProfit;
    uint256 internal loopNotional;
    uint256 internal drainDay;
    uint256 internal gradDay;
    uint256 internal volWad;
    bool internal dead;
    uint256 internal anchorRng;
    uint256 internal dayRng;
    uint256 internal bidAt;
    uint256 internal askAt;
    int256 internal retailMark;
    int256 internal lastMark;
    uint256 internal dripBudget;
    uint256 internal dripSubsidy;
    uint256 internal dripFilledHour;
    uint256 internal horizon = 365;
    string internal tag;

    function test_recommendedSeedIsAllCoin() public pure {
        BridgeCurve.S memory m;
        BridgeCurve.init(m, SEED, 0.33e18);
        BridgeCurve.onAnchor(m, START);
        assertEq(m.x, SEED);
        assertEq(m.y, 0);
        assertEq(BridgeCurve.spot(m), 0.67e18);
        assertEq(GRAD, 86_520e18);
        uint256 jesus = Math.mulDiv(SEED, C.WAD, JESUS_PRICE_WAD);
        assertGt(jesus, 5.66e27);
        assertLt(jesus, 5.67e27);
    }

    /// @dev A trade resets that side. With no time passing, the next buy and the next sell
    ///      are both at the anchor, so the round trip cannot profit.
    function test_dutchGapResetsAndDoesNotLoop() public {
        _reset(COST_OUTSIDE, MODE_DUTCH, 0, false);
        clock = 1 hours;
        assertApproxEqAbs(_dutchGap(bidAt), 0.01e18, 1e12, "1% per hour");
        // Fifty hours. The slice has shrunk with the gap, so impact no longer eats the discount.
        clock = 50 hours;
        uint256 gap = _dutchGap(bidAt);
        uint256 offered = _dutchOffer(gap);
        assertLe(offered, DUTCH_MAX_SLICE);
        assertLe(offered, BridgeCurve.tvl(s) / 20, "one slice is at most 5% of the pool");
        assertLt(offered, 1e18, "a 50% gap offers less than $1");
        assertGt(offered, 0.4e18);
        int256 before = loopMark;
        uint256 got = _dutchBuy(offered, ACT_LOOP);
        assertGt(got, 0);
        assertEq(_dutchGap(bidAt), 0, "the bid resets when it is taken");
        assertGt(_dutchGap(askAt), 0, "the ask is a separate quote");
        uint256 ask = Math.mulDiv(s.anchor, C.WAD + _dutchGap(askAt), C.WAD);
        uint256 dx = Math.mulDiv(_dutchOffer(_dutchGap(askAt)), C.WAD, ask);
        assertGt(_dutchSell(dx, ACT_LOOP), 0);
        assertEq(_dutchGap(askAt), 0, "the ask resets when it is taken");
        assertGt(loopMark, before, "the two rested slices pay the searcher once");
        assertGe(s.x, s.seedFloor);
        int256 rested = loopMark;
        _dutchBuy(10e18, ACT_LOOP);
        uint256 px = _spot() == 0 ? s.anchor : _spot();
        _dutchSell(Math.mulDiv(5e18, C.WAD, px), ACT_LOOP);
        assertLe(loopMark, rested, "without more time the next round trip does not profit");
        // A later, wider quote is a smaller slice, not a larger one. Past a full discount the
        // bid price sits at 1% of the anchor and the slice keeps shrinking. There is no gap cap.
        clock = 90 hours;
        bidAt = 0;
        uint256 wide = _dutchOffer(_dutchGap(bidAt));
        assertLt(wide, offered, "a late quote offers less");
        clock = 200 hours;
        uint256 later = _dutchOffer(_dutchGap(bidAt));
        assertLt(later, wide, "past a full discount the slice is still shrinking");
        assertGt(later, 0);
        uint256 xBefore = s.x;
        assertGt(_dutchBuy(later, ACT_LOOP), 0, "the cheap slice still clears the curve");
        assertLt(s.x, xBefore);
        assertGe(s.x, s.seedFloor, "the seed guard still binds");
        assertApproxEqRel(_spot(), s.anchor, 0.001e18, "the bid rests back on the anchor");
    }

    function test_dripSubsidyCannotExceedFees() public {
        _reset(COST_LOW, MODE_DRIP, 0, false);
        dripBudget = 10e18;
        fees = 10e18;
        clock = 30 minutes;
        uint256 x0 = s.x;
        _drip();
        assertEq(s.x, x0, "no surplus coin, so the seed is not auctioned");
        assertEq(dripSubsidy, 0);
        s.x += 5e18;
        s.protoX += 5e18;
        s.y += 20e18;
        s.protoY += 20e18;
        // Half an hour into the hour, so the dutch price has already passed the searcher's cost.
        clock = 2 hours + 30 minutes;
        _drip();
        assertGe(s.x, s.initialSeed, "the drip sells surplus coin only");
        assertLt(s.x, x0 + 5e18, "the surplus was offered");
        assertGt(dripSubsidy, 0);
        assertLe(dripSubsidy, fees, "the discount is paid out of fees");
    }

    /// @dev A 10% rally on a balanced book opens a gap of about amplification times the move,
    ///      on the side that buys coin back to 50/50. Selling coin into that quote loses.
    function test_levammOnlyTheRestoringSideIsRich() public {
        _reset(COST_OUTSIDE, MODE_LEV, 0, false);
        s.x = 100e18;
        s.protoX = 100e18;
        s.y = 100e18;
        s.protoY = 100e18;
        s.initialSeed = 100e18;
        s.anchor = START;
        _levammRetarget();
        assertApproxEqRel(_spot(), START, 0.02e18, "50/50 quotes the oracle");
        _applyAnchor(1.1e18);
        assertLt(_spot(), s.anchor, "coin is heavy, so the quote is under the oracle");
        uint256 gap = s.anchor - _spot();
        assertGt(gap, Math.mulDiv(s.anchor, 0.15e18, C.WAD), "the launch amplification widens the move");
        assertLt(gap, Math.mulDiv(s.anchor, 0.5e18, C.WAD), "a 10% move stays inside the linear region");
        int256 mark0 = arbMark;
        _applySell(1e18, ACT_ARB);
        assertLt(arbMark, mark0, "the wrong way loses mark-to-anchor");
        int256 mark1 = arbMark;
        _applyBuy(5e18, ACT_ARB);
        _levammRetarget();
        assertGt(arbMark, mark1, "buying coin back toward the mix is paid");
    }

    /// @dev Two days of every shape, so a revert is caught before the year-long run.
    function test_simSmoke() public {
        horizon = 2;
        _profile("ACT", "OUT", "BASE", COST_OUTSIDE, MODE_BASE, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "REV", COST_OUTSIDE, 0, VOL_ACTIVE, false);
        _profile("ACT", "LOW", "REV", COST_LOW, 0, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "A", COST_OUTSIDE, MODE_A, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "B", COST_OUTSIDE, MODE_B, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "C", COST_OUTSIDE, MODE_C, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "D", COST_OUTSIDE, MODE_D, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "LEV", COST_OUTSIDE, MODE_LEV, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "DUTCH", COST_OUTSIDE, MODE_DUTCH, VOL_ACTIVE, false);
        _profile("DEAD", "LOW", "DRIP", COST_LOW, MODE_DRIP, VOL_DEAD, true);
    }

    function test_simActive() public {
        _campaign(VOL_ACTIVE, false, "ACT");
    }

    function test_simDead() public {
        _campaign(VOL_DEAD, true, "DEAD");
    }

    function _campaign(uint256 vol, bool dead_, string memory scene) internal {
        _profile(scene, "OUT", "BASE", COST_OUTSIDE, MODE_BASE, vol, dead_);
        _profile(scene, "LOW", "BASE", COST_LOW, MODE_BASE, vol, dead_);
        _profile(scene, "OUT", "REV", COST_OUTSIDE, 0, vol, dead_);
        _profile(scene, "LOW", "REV", COST_LOW, 0, vol, dead_);
        _profile(scene, "OUT", "A", COST_OUTSIDE, MODE_A, vol, dead_);
        _profile(scene, "LOW", "A", COST_LOW, MODE_A, vol, dead_);
        _profile(scene, "OUT", "B", COST_OUTSIDE, MODE_B, vol, dead_);
        _profile(scene, "LOW", "B", COST_LOW, MODE_B, vol, dead_);
        _profile(scene, "OUT", "C", COST_OUTSIDE, MODE_C, vol, dead_);
        _profile(scene, "LOW", "C", COST_LOW, MODE_C, vol, dead_);
        _profile(scene, "OUT", "D", COST_OUTSIDE, MODE_D, vol, dead_);
        _profile(scene, "LOW", "D", COST_LOW, MODE_D, vol, dead_);
        _profile(scene, "OUT", "LEV", COST_OUTSIDE, MODE_LEV, vol, dead_);
        _profile(scene, "LOW", "LEV", COST_LOW, MODE_LEV, vol, dead_);
        _profile(scene, "OUT", "DUTCH", COST_OUTSIDE, MODE_DUTCH, vol, dead_);
        _profile(scene, "LOW", "DUTCH", COST_LOW, MODE_DUTCH, vol, dead_);
        _profile(scene, "OUT", "DRIP", COST_OUTSIDE, MODE_DRIP, vol, dead_);
        _profile(scene, "LOW", "DRIP", COST_LOW, MODE_DRIP, vol, dead_);
    }

    function _profile(
        string memory scene,
        string memory actor,
        string memory variant,
        uint256 cost,
        uint8 mode_,
        uint256 vol,
        bool dead_
    ) internal {
        tag = string.concat(scene, " ", actor, " ", variant);
        _reset(cost, mode_, vol, dead_);
        _run();
        if (mode_ == MODE_DRIP) assertLe(dripSubsidy, fees, "drip subsidy stays inside fees");
        assertGe(s.x, s.seedFloor, "seed guard holds");
    }

    function _reset(uint256 cost, uint8 mode_, uint256 vol, bool dead_) internal {
        BridgeCurve.S memory m;
        BridgeCurve.init(m, SEED, 0.33e18);
        BridgeCurve.onAnchor(m, START);
        if (mode_ == MODE_DUTCH) BridgeCurve.retarget(m, START);
        s = m;
        fees = 0;
        arbMark = 0;
        arbProfit = 0;
        missed = 0;
        tipBudget = 0;
        graduated = false;
        rng = 1;
        gapSum = 0;
        gapN = 0;
        arbNotional = 0;
        grossNotional = 0;
        clock = 0;
        revVolume = 0;
        revAt = 0;
        costWad = cost;
        mode = mode_;
        overshootAt = 0;
        attackerHold = 0;
        attackerNextBuy = 0;
        attackerNextSell = 0;
        arbNextBuy = 0;
        arbNextSell = 0;
        loopMark = 0;
        loopProfit = 0;
        loopNotional = 0;
        drainDay = 0;
        gradDay = 0;
        volWad = vol;
        dead = dead_;
        anchorRng = 42;
        dayRng = 99;
        bidAt = 0;
        askAt = 0;
        retailMark = 0;
        lastMark = 0;
        dripBudget = 0;
        dripSubsidy = 0;
        dripFilledHour = type(uint256).max;
    }

    function _run() internal {
        for (uint256 day = 1; day <= horizon; ++day) {
            // Each day is its own call so the EVM frees that day's curve copies. A year of
            // profiles in one call grows memory until MemoryLimitOOG.
            this.runDay();
            if (drainDay == 0 && BridgeCurve.tvl(s) < SEED / 2) drainDay = day;
            if (gradDay == 0 && BridgeCurve.tvl(s) >= GRAD) {
                graduated = true;
                gradDay = day;
            }
            if (day == 7 || day == 90 || day == 365) _milestone(day);
        }
    }

    /// @dev One retail day. External so the memory used by the clips dies with the call.
    function runDay() external {
        require(msg.sender == address(this));
        uint256 budget = _budgetForDay();
        uint256 vol;
        uint256 guard;
        while (vol < budget && guard < 500) {
            unchecked {
                ++guard;
            }
            uint256 amt = 5e18 + (_rnd() % (45e18 + 1));
            if (vol + amt > budget) amt = budget - vol;
            if (amt == 0) break;
            uint256 step = (1 days * amt) / budget;
            if (step == 0) step = 1;
            clock += step;
            _moveAnchor(step);
            _decayOvershoot();
            bool buy = _rnd() % 2 == 0;
            if (!buy && s.y < 1e18) buy = true;
            if (buy) _routeBuy(amt, ACT_RETAIL);
            else _routeSell(Math.mulDiv(amt, C.WAD, _spot() == 0 ? s.anchor : _spot()), ACT_RETAIL);
            _relist(buy);
            vol += amt;
            _recordGap();
            _attack();
            arbNotional += _arb();
            _drip();
        }
    }

    function _budgetForDay() internal returns (uint256) {
        if (!dead) return DAILY_ACTIVE;
        return 100e18 + (_dayRnd() % (100e18 + 1));
    }

    function _milestone(uint256 day) internal view {
        uint256 denom = day == 0 ? 1 : day;
        int256 lost = arbMark + loopMark;
        uint256 gap = gapN == 0 ? 0 : gapSum / gapN;
        string memory line = string.concat(
            "MILESTONE ",
            tag,
            " day ",
            vm.toString(day),
            " tvl ",
            vm.toString(BridgeCurve.tvl(s)),
            " gap ",
            vm.toString(gap),
            " arbDay ",
            vm.toString(arbNotional / denom),
            " profitDay ",
            vm.toString(arbProfit / int256(denom)),
            " feesDay ",
            vm.toString(fees / denom),
            " lostDay ",
            vm.toString(lost / int256(denom)),
            " lost ",
            vm.toString(lost),
            " grad ",
            vm.toString(gradDay),
            " loopDay ",
            vm.toString(loopProfit / int256(denom)),
            " retailDay ",
            vm.toString(retailMark / int256(denom)),
            " effBps ",
            vm.toString(grossNotional == 0 ? uint256(0) : (fees * C.BPS) / grossNotional),
            " drain ",
            vm.toString(drainDay),
            " anchor ",
            vm.toString(s.anchor),
            " samples ",
            vm.toString(gapN)
        );
        console2.log(line);
    }

    function _routeBuy(uint256 usdgIn, uint8 actor) internal returns (uint256) {
        if (mode == MODE_DUTCH) return _dutchBuy(usdgIn, actor);
        return _applyBuy(usdgIn, actor);
    }

    function _routeSell(uint256 dx, uint8 actor) internal returns (uint256) {
        if (mode == MODE_DUTCH) return _dutchSell(dx, actor);
        return _applySell(dx, actor);
    }

    function _recordGap() internal {
        if (mode == MODE_DUTCH) {
            // Price distance, saturated at 100% so a year of silence does not dominate the
            // average. Size still uses the raw gap and keeps shrinking past that.
            uint256 gb = _dutchBidGap(_dutchGap(bidAt));
            uint256 ga = _dutchGap(askAt);
            if (ga > C.WAD) ga = C.WAD;
            gapSum += gb > ga ? gb : ga;
            gapN += 1;
            return;
        }
        uint256 p = _spot();
        uint256 a = s.anchor;
        if (p == 0 || a == 0) return;
        uint256 gap = p > a ? p - a : a - p;
        gapSum += Math.mulDiv(gap, C.WAD, a);
        gapN += 1;
    }

    function _arb() internal returns (uint256 added) {
        if (mode == MODE_DUTCH) return _arbDutch();
        for (uint256 i; i < 16; ++i) {
            uint256 p = _spot();
            uint256 a = s.anchor;
            if (p == 0 || a == 0) break;
            uint256 yEff = s.y + s.vy;
            if (yEff == 0) break;
            if (p < a) {
                if (mode == MODE_C && clock < arbNextBuy) break;
                uint256 raw = Math.mulDiv(a - p, yEff, p) / 2;
                uint256 amt = _clamp(raw, 1e18, 5_000e18);
                if (!_clears(p, amt, true)) {
                    _missedBuy(amt);
                    break;
                }
                uint256 filled = _routeBuy(amt, ACT_ARB);
                if (filled == 0) break;
                if (mode == MODE_C) arbNextSell = clock + FLIP_COOLDOWN;
                _relist(true);
                added += filled;
            } else if (p > a && s.y > 1e18) {
                if (mode == MODE_C && clock < arbNextSell) break;
                uint256 raw = Math.mulDiv(p - a, yEff, p) / 2;
                uint256 usd = _clamp(raw, 1e18, 5_000e18);
                uint256 dx = Math.mulDiv(usd, C.WAD, p);
                if (dx == 0 || !_clears(p, usd, false)) {
                    if (dx != 0) _missedSell(dx);
                    break;
                }
                uint256 filled = _routeSell(dx, ACT_ARB);
                if (filled == 0) break;
                if (mode == MODE_C) arbNextBuy = clock + FLIP_COOLDOWN;
                _relist(false);
                added += filled;
            } else {
                break;
            }
        }
    }

    function _arbDutch() internal returns (uint256 added) {
        uint256 bidGap = _dutchGap(bidAt);
        uint256 bidSize = bidGap == 0 ? 0 : _dutchOffer(bidGap);
        if (bidSize > 0 && bidGap > _slack(bidSize)) added += _dutchBuy(bidSize, ACT_ARB);
        uint256 askGap = _dutchGap(askAt);
        uint256 askSize = askGap == 0 ? 0 : _dutchOffer(askGap);
        if (askSize > 0 && askGap > _slack(askSize) && s.y > 1e18) {
            uint256 ask = Math.mulDiv(s.anchor, C.WAD + askGap, C.WAD);
            uint256 dx = Math.mulDiv(askSize, C.WAD, ask);
            if (dx > 0) added += _dutchSell(dx, ACT_ARB);
        }
    }

    function _clears(uint256 p, uint256 notion, bool buying) internal view returns (bool) {
        uint256 slack = _slack(notion);
        if (slack >= C.WAD || s.anchor == 0) return false;
        if (buying) return p < Math.mulDiv(s.anchor, C.WAD - slack, C.WAD);
        return p > s.anchor + Math.mulDiv(s.anchor, slack, C.WAD);
    }

    function _slack(uint256 notion) internal view returns (uint256) {
        return _revBps(notion) * 1e14 + costWad;
    }

    function _missedBuy(uint256 usdgIn) internal {
        BridgeCurve.Fill memory f;
        (, f) = BridgeCurve.buyExactIn(s, usdgIn, _ctx(s));
        if (f.coinOut == 0) return;
        int256 mark = int256(Math.mulDiv(f.coinOut, s.anchor, C.WAD)) - int256(f.usdgIn);
        if (mark > 0) missed += uint256(mark);
    }

    function _missedSell(uint256 dx) internal {
        BridgeCurve.S memory m = s;
        BridgeCurve.Ctx memory c = _ctx(m);
        c.maxUsdgOut = BridgeCurve.floorRoom(m, c.floorBps);
        BridgeCurve.Fill memory f;
        (, f) = BridgeCurve.sellExactIn(m, dx, c);
        if (f.coinIn == 0) return;
        int256 mark = int256(f.usdgOut) - int256(Math.mulDiv(f.coinIn, s.anchor, C.WAD));
        if (mark > 0) missed += uint256(mark);
    }

    function _applyBuy(uint256 usdgIn, uint8 actor) internal returns (uint256 filled) {
        if (usdgIn == 0) return 0;
        BridgeCurve.S memory m = s;
        BridgeCurve.Fill memory f;
        (m, f) = BridgeCurve.buyExactIn(m, usdgIn, _ctx(m));
        if (f.coinOut == 0) {
            lastMark = 0;
            return 0;
        }
        s = m;
        _book(f.fee, f.tip);
        _commitRev(f.usdgIn);
        grossNotional += f.usdgIn;
        int256 mark = int256(Math.mulDiv(f.coinOut, s.anchor, C.WAD)) - int256(f.usdgIn);
        lastMark = mark;
        _attribute(actor, mark, f.usdgIn);
        if (actor == ACT_LOOP) attackerHold += f.coinOut;
        return f.usdgIn;
    }

    function _applySell(uint256 dx, uint8 actor) internal returns (uint256 filled) {
        if (dx == 0) return 0;
        BridgeCurve.S memory m = s;
        BridgeCurve.Ctx memory c = _ctx(m);
        c.maxUsdgOut = BridgeCurve.floorRoom(m, c.floorBps);
        BridgeCurve.Fill memory f;
        (m, f) = BridgeCurve.sellExactIn(m, dx, c);
        if (f.usdgOut == 0 && f.coinIn == 0) {
            lastMark = 0;
            return 0;
        }
        s = m;
        _book(f.fee, f.tip);
        uint256 gross = f.usdgOut + f.fee;
        _commitRev(gross);
        grossNotional += gross;
        int256 mark;
        if (f.coinIn > 0) {
            mark = int256(f.usdgOut) - int256(Math.mulDiv(f.coinIn, s.anchor, C.WAD));
            _attribute(actor, mark, gross);
            if (actor == ACT_LOOP) attackerHold = attackerHold > f.coinIn ? attackerHold - f.coinIn : 0;
        }
        lastMark = mark;
        return f.usdgOut;
    }

    function _attribute(uint8 actor, int256 mark, uint256 gross) internal {
        if (actor == ACT_ARB) {
            arbMark += mark;
            arbProfit += mark - int256(Math.mulDiv(gross, costWad, C.WAD));
        } else if (actor == ACT_LOOP) {
            loopMark += mark;
            loopProfit += mark - int256(Math.mulDiv(gross, COST_LOW, C.WAD));
            loopNotional += gross;
        } else if (actor == ACT_RETAIL && mode == MODE_DUTCH) {
            retailMark += mark;
        }
    }

    function _relist(bool bought) internal {
        if (mode == MODE_LEV) {
            _levammRetarget();
            return;
        }
        if (mode != MODE_A && mode != MODE_B && mode != MODE_C && mode != MODE_D) return;
        uint256 p = _spot();
        uint256 a = s.anchor;
        if (p == 0 || a == 0 || p == a) return;
        uint256 target;
        if (bought && p < a) target = a + (a - p);
        else if (!bought && p > a) target = p >= a + a ? 1 : a - (p - a);
        else return;
        if (mode == MODE_B) target = _capBelowRoundTrip(target);
        if (target == 0 || target == p) return;
        _setSpot(target);
        overshootAt = clock;
    }

    function _capBelowRoundTrip(uint256 target) internal view returns (uint256) {
        uint256 a = s.anchor;
        uint256 rtBps = _revBps(0) * 2;
        if (rtBps <= 1 || a == 0) return a;
        uint256 gap = Math.mulDiv(a, rtBps - 1, C.BPS);
        if (target >= a) {
            uint256 maxT = a + gap;
            return target > maxT ? maxT : target;
        }
        uint256 minT = a > gap ? a - gap : 1;
        return target < minT ? minT : target;
    }

    function _decayOvershoot() internal {
        if (mode != MODE_D || overshootAt == 0 || clock <= overshootAt) return;
        uint256 p = _spot();
        uint256 a = s.anchor;
        if (p == 0 || a == 0 || p == a) {
            overshootAt = 0;
            return;
        }
        uint256 dt = clock - overshootAt;
        if (p > a) {
            uint256 gap = BridgeFee.decayed(p - a, dt, OVERSHOOT_HALF);
            _setSpot(a + gap);
        } else {
            uint256 gap = BridgeFee.decayed(a - p, dt, OVERSHOOT_HALF);
            if (gap >= a) return;
            _setSpot(a - gap);
        }
        overshootAt = clock;
    }

    function _attack() internal {
        if (mode == 0 || mode == MODE_BASE || mode == MODE_DRIP || mode == MODE_DUTCH) return;
        if (mode == MODE_LEV) {
            _attackLev();
            return;
        }
        uint256 legs = mode == MODE_A ? 12 : 4;
        for (uint256 i; i < legs; ++i) {
            if (mode == MODE_A && BridgeCurve.tvl(s) < SEED / 2) return;
            uint256 p = _spot();
            uint256 a = s.anchor;
            if (p == 0 || a == 0 || p == a) return;
            uint256 yEff = s.y + s.vy;
            if (yEff == 0) return;
            if (p < a) {
                if (mode == MODE_C && clock < attackerNextBuy) return;
                uint256 raw = Math.mulDiv(a - p, yEff, p) / 2;
                uint256 amt = _clamp(raw, 1e18, 5_000e18);
                if (!_tryBuy(amt)) return;
                _relist(true);
            } else {
                if (s.y < 1e18) return;
                if (mode == MODE_C && clock < attackerNextSell) return;
                uint256 raw = Math.mulDiv(p - a, yEff, p) / 2;
                uint256 usd = _clamp(raw, 1e18, 5_000e18);
                uint256 dx = Math.mulDiv(usd, C.WAD, p);
                if (dx == 0 || !_trySell(dx)) return;
                _relist(false);
            }
        }
    }

    /// @dev One restoring leg, then the opposite leg. The second leg is kept only when it
    ///      still makes money after the mix quote is refreshed. That is the free-loop check.
    function _attackLev() internal {
        uint256 p = _spot();
        uint256 a = s.anchor;
        if (p == 0 || a == 0 || p == a) return;
        if (p < a) {
            uint256 amt = _clip(a - p, true);
            if (amt == 0 || !_tryBuy(amt)) return;
            _levammRetarget();
            uint256 dx = _clip(_spot() > a ? _spot() - a : 0, false);
            if (dx > 0) _trySell(dx);
        } else {
            uint256 dx = _clip(p - a, false);
            if (dx == 0 || !_trySell(dx)) return;
            _levammRetarget();
            uint256 amt = _clip(a > _spot() ? a - _spot() : 0, true);
            if (amt > 0) _tryBuy(amt);
        }
    }

    function _clip(uint256 gap, bool buy) internal view returns (uint256) {
        if (gap == 0) return 0;
        uint256 p = _spot();
        if (p == 0) return 0;
        uint256 yEff = s.y + s.vy;
        if (yEff == 0) return 0;
        uint256 raw = Math.mulDiv(gap, yEff, p) / 2;
        if (!buy) {
            uint256 usd = _clamp(raw, 1e18, 5_000e18);
            return Math.mulDiv(usd, C.WAD, p);
        }
        return _clamp(raw, 1e18, 5_000e18);
    }

    function _tryBuy(uint256 amt) internal returns (bool ok) {
        Snap memory n = _snap();
        int256 before = loopMark;
        if (_applyBuy(amt, ACT_LOOP) == 0 || loopMark <= before) {
            _restore(n);
            return false;
        }
        if (mode == MODE_C) attackerNextSell = clock + FLIP_COOLDOWN;
        return true;
    }

    function _trySell(uint256 dx) internal returns (bool ok) {
        Snap memory n = _snap();
        int256 before = loopMark;
        if (_applySell(dx, ACT_LOOP) == 0 || loopMark <= before) {
            _restore(n);
            return false;
        }
        if (mode == MODE_C) attackerNextBuy = clock + FLIP_COOLDOWN;
        return true;
    }

    function _dutchGap(uint256 since) internal view returns (uint256) {
        if (clock <= since) return 0;
        return (clock - since) * DUTCH_PER_SEC;
    }

    /// @dev Numerical floor for the bid price only. A quote cannot print below zero.
    function _dutchBidGap(uint256 gap) internal pure returns (uint256) {
        return gap > 0.99e18 ? 0.99e18 : gap;
    }

    function _dutchOffer(uint256 gap) internal view returns (uint256) {
        if (gap == 0) return 0;
        uint256 offered = Math.mulDiv(DUTCH_EDGE, C.WAD, gap);
        if (offered > DUTCH_MAX_SLICE) offered = DUTCH_MAX_SLICE;
        uint256 cap = BridgeCurve.tvl(s) / 20;
        if (cap < 1e18) cap = 1e18;
        if (offered > cap) offered = cap;
        return offered;
    }

    function _dutchBuy(uint256 usdgIn, uint8 actor) internal returns (uint256 filled) {
        uint256 gap = _dutchGap(bidAt);
        uint256 offered = gap == 0 ? 0 : _dutchOffer(gap);
        if (gap > 0 && offered > 0 && (actor == ACT_RETAIL || gap > _slack(offered))) {
            uint256 slice = usdgIn < offered ? usdgIn : offered;
            uint256 bid = Math.mulDiv(s.anchor, C.WAD - _dutchBidGap(gap), C.WAD);
            if (bid == 0) bid = 1;
            _setSpot(bid);
            filled = _applyBuy(slice, actor);
            bidAt = clock;
            _setSpot(s.anchor);
            if (actor == ACT_RETAIL && usdgIn > slice) filled += _applyBuy(usdgIn - slice, actor);
            return filled;
        }
        return _applyBuy(usdgIn, actor);
    }

    function _dutchSell(uint256 dx, uint8 actor) internal returns (uint256 filled) {
        uint256 gap = _dutchGap(askAt);
        uint256 offered = gap == 0 ? 0 : _dutchOffer(gap);
        if (gap > 0 && offered > 0 && (actor == ACT_RETAIL || gap > _slack(offered)) && s.anchor != 0) {
            uint256 ask = Math.mulDiv(s.anchor, C.WAD + gap, C.WAD);
            uint256 maxDx = Math.mulDiv(offered, C.WAD, ask);
            uint256 slice = dx < maxDx ? dx : maxDx;
            if (slice == 0) return _applySell(dx, actor);
            _setSpot(ask);
            filled = _applySell(slice, actor);
            askAt = clock;
            _setSpot(s.anchor);
            if (actor == ACT_RETAIL && dx > slice) filled += _applySell(dx - slice, actor);
            return filled;
        }
        return _applySell(dx, actor);
    }

    function _levammRetarget() internal {
        if (s.anchor == 0 || s.x == 0) return;
        if (s.y == 0) {
            uint256 spot0 = Math.mulDiv(s.anchor, C.WAD - s.discountWad, C.WAD);
            if (spot0 == 0) spot0 = 1;
            _setSpot(spot0);
            return;
        }
        uint256 coinVal = Math.mulDiv(s.x, s.anchor, C.WAD);
        if (coinVal == 0) return;
        uint256 stable = s.y;
        uint256 sum = coinVal + stable;
        int256 imb = coinVal >= stable
            ? int256(Math.mulDiv(coinVal - stable, C.WAD, sum))
            : -int256(Math.mulDiv(stable - coinVal, C.WAD, sum));
        int256 gap = imb * 2 * int256(_amp()) / int256(C.WAD);
        if (gap > 0.95e18) gap = 0.95e18;
        if (gap < -0.95e18) gap = -0.95e18;
        uint256 target = Math.mulDiv(s.anchor, uint256(int256(C.WAD) - gap), C.WAD);
        if (target == 0) target = 1;
        _setSpot(target);
    }

    function _amp() internal view returns (uint256) {
        uint256 v = BridgeCurve.tvl(s);
        if (v >= GRAD) return AMP_END;
        return AMP_END + Math.mulDiv(AMP_START - AMP_END, GRAD - v, GRAD);
    }

    function _drip() internal {
        if (mode != MODE_DRIP || s.anchor == 0 || s.x == 0) return;
        uint256 hourStart = (clock / 1 hours) * 1 hours;
        if (dripFilledHour == hourStart) return;
        uint256 elapsed = clock - hourStart;
        if (elapsed > 1 hours) elapsed = 1 hours;
        uint256 discount = Math.mulDiv(elapsed, C.WAD, 1 hours);
        uint256 slack = _slack(dripBudget == 0 ? 1 : dripBudget);
        if (discount < slack) return;
        if (dripBudget == 0 || s.x <= s.initialSeed) return;
        if (slack >= C.WAD) return;
        uint256 price = Math.mulDiv(s.anchor, C.WAD - slack, C.WAD);
        if (price == 0) return;
        uint256 surplusCoin = s.x - s.initialSeed;
        uint256 surplusVal = Math.mulDiv(surplusCoin, s.anchor, C.WAD);
        uint256 lotValue = dripBudget < surplusVal ? dripBudget : surplusVal;
        // Keep the walk inside the discount. A lot the size of the book would be filled
        // above the anchor, and the searcher would not take it.
        uint256 depth = Math.mulDiv(s.x, price, C.WAD);
        uint256 maxPay = Math.mulDiv(depth, slack, C.WAD) / 4;
        if (maxPay < lotValue) lotValue = maxPay;
        uint256 lotCoin = Math.mulDiv(lotValue, C.WAD, s.anchor);
        if (lotCoin == 0 || lotCoin > surplusCoin) return;
        uint256 pay = Math.mulDiv(lotCoin, price, C.WAD);
        if (pay == 0) return;
        uint256 resting = _spot();
        _setSpot(price);
        uint256 filled = _applyBuy(pay, ACT_ARB);
        if (resting != 0) _setSpot(resting);
        if (filled == 0) return;
        arbNotional += filled;
        if (lastMark > 0) {
            uint256 sub = uint256(lastMark);
            if (sub > dripBudget) sub = dripBudget;
            dripBudget -= sub;
            dripSubsidy += sub;
        }
        dripFilledHour = hourStart;
    }

    function _moveAnchor(uint256 dt) internal {
        if (dt == 0 || volWad == 0 || s.anchor == 0) return;
        int256 z = _gauss();
        uint256 uWad = Math.mulDiv(dt, C.WAD, 1 days);
        uint256 sqrtU = Math.sqrt(uWad * C.WAD);
        int256 expo = z * int256(volWad) / int256(C.WAD);
        expo = expo * int256(sqrtU) / int256(C.WAD);
        if (expo > 0.2e18) expo = 0.2e18;
        if (expo < -0.2e18) expo = -0.2e18;
        uint256 factor = _expWad(expo);
        uint256 next = Math.mulDiv(s.anchor, factor, C.WAD);
        if (next < 1e12) next = 1e12;
        _applyAnchor(next);
    }

    function _applyAnchor(uint256 next) internal {
        if (next == 0) return;
        if (mode == MODE_LEV) {
            s.anchor = next;
            _levammRetarget();
            return;
        }
        if (mode == MODE_DUTCH) {
            s.anchor = next;
            _setSpot(next);
            return;
        }
        BridgeCurve.S memory m = s;
        BridgeCurve.onAnchor(m, next);
        s = m;
    }

    function _setSpot(uint256 target) internal {
        if (target == 0) target = 1;
        BridgeCurve.S memory m = s;
        BridgeCurve.retarget(m, target);
        s = m;
    }

    function _snap() internal view returns (Snap memory n) {
        n.s = s;
        n.fees = fees;
        n.arbMark = arbMark;
        n.arbProfit = arbProfit;
        n.missed = missed;
        n.tipBudget = tipBudget;
        n.arbNotional = arbNotional;
        n.grossNotional = grossNotional;
        n.revVolume = revVolume;
        n.revAt = revAt;
        n.attackerHold = attackerHold;
        n.loopMark = loopMark;
        n.loopProfit = loopProfit;
        n.loopNotional = loopNotional;
        n.overshootAt = overshootAt;
        n.retailMark = retailMark;
        n.dripBudget = dripBudget;
        n.dripSubsidy = dripSubsidy;
    }

    function _restore(Snap memory n) internal {
        s = n.s;
        fees = n.fees;
        arbMark = n.arbMark;
        arbProfit = n.arbProfit;
        missed = n.missed;
        tipBudget = n.tipBudget;
        arbNotional = n.arbNotional;
        grossNotional = n.grossNotional;
        revVolume = n.revVolume;
        revAt = n.revAt;
        attackerHold = n.attackerHold;
        loopMark = n.loopMark;
        loopProfit = n.loopProfit;
        loopNotional = n.loopNotional;
        overshootAt = n.overshootAt;
        retailMark = n.retailMark;
        dripBudget = n.dripBudget;
        dripSubsidy = n.dripSubsidy;
    }

    function _book(uint256 fee, uint256 tip) internal {
        fees += fee;
        if (mode == MODE_DRIP && fee != 0) dripBudget += fee;
        tipBudget += tip;
        if (tipBudget > C.TIP_BUDGET_CAP) tipBudget = C.TIP_BUDGET_CAP;
    }

    function _commitRev(uint256 notion) internal {
        if (notion == 0) return;
        revVolume = _decayedVol() + notion;
        revAt = clock;
    }

    function _decayedVol() internal view returns (uint256) {
        uint256 dt = revAt == 0 || clock <= revAt ? 0 : clock - revAt;
        return BridgeFee.decayed(revVolume, dt, C.REV_HALF_LIFE);
    }

    function _revBps(uint256 extra) internal view returns (uint256) {
        uint256 v = BridgeCurve.tvl(s);
        return BridgeFee.revBps(v, GRAD, _decayedVol() + extra, _red(), v);
    }

    function _red() internal view returns (uint256) {
        return mode == MODE_BASE ? 0 : C.REV_RED_LINE_WAD;
    }

    function _ctx(BridgeCurve.S memory m) internal view returns (BridgeCurve.Ctx memory c) {
        c.gradTvl = GRAD;
        c.floorBps = C.FLOOR_BPS;
        c.maxUsdgOut = type(uint256).max;
        c.boostWad = BridgeFee.boostWad(BridgeCurve.tvl(m), GRAD);
        c.tipRoom = tipBudget >= C.TIP_BUDGET_CAP ? 0 : C.TIP_BUDGET_CAP - tipBudget;
        c.graduated = graduated;
        c.revVolume = _decayedVol();
        c.revRedLineWad = _red();
        c.revTvl = BridgeCurve.tvl(m);
    }

    function _spot() internal view returns (uint256) {
        return BridgeCurve.spot(s);
    }

    function _rnd() internal returns (uint256) {
        rng = uint256(keccak256(abi.encode(rng)));
        return rng;
    }

    function _anchorRnd() internal returns (uint256) {
        anchorRng = uint256(keccak256(abi.encode(anchorRng, uint256(1))));
        return anchorRng;
    }

    function _dayRnd() internal returns (uint256) {
        dayRng = uint256(keccak256(abi.encode(dayRng, uint256(2))));
        return dayRng;
    }

    /// @dev Sum of 12 uniforms on [0, 1) minus 6. The variance of one uniform is 1/12,
    ///      so twelve of them are about N(0, 1), scaled by 1e18.
    function _gauss() internal returns (int256 z) {
        int256 sum;
        for (uint256 i; i < 12; ++i) {
            sum += int256(_anchorRnd() % 1e18);
        }
        return sum - 6e18;
    }

    function _expWad(int256 x) internal pure returns (uint256) {
        if (x == 0) return C.WAD;
        bool neg = x < 0;
        uint256 z = uint256(neg ? -x : x);
        uint256 term = C.WAD;
        uint256 sum = C.WAD;
        for (uint256 i = 1; i <= 16; ++i) {
            term = Math.mulDiv(term, z, C.WAD * i);
            if (term == 0) break;
            sum += term;
        }
        if (!neg) return sum;
        if (sum == 0) return 0;
        return Math.mulDiv(C.WAD, C.WAD, sum);
    }

    function _clamp(uint256 v, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }
}

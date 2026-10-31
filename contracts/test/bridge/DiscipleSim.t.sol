// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BridgeCurve} from "../../src/bridge/libraries/BridgeCurve.sol";
import {BridgeFee} from "../../src/bridge/libraries/BridgeFee.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";

/// @notice Simulator only. Nothing in this file is part of the hook.
///
/// Every profile shares one retail stream and one oracle path. The anchor mean-reverts
/// around $1 (7-day half-life of the log deviation) with no trend. Daily volatility is 3%
/// active and 0.1% dead. Seeds are shared, so a variant cannot knock the path off the one
/// the others see.
///
/// `test_simV2` runs one searcher, OUT, who pays the pool fee plus 0.5%. That is the
/// binding cost. LOW (fee plus about 0.05%) stays in the unit tests and the smoke run.
/// The hook is generic, so the launch team is not assumed to run the searcher.
///
/// Dutch-family books are parked on the anchor after each quote and on each anchor move,
/// so the gap is only the time quote. The shipped hook instead returns the curve to its
/// pre-trade spot, and a zero gap leaves the launch discount on the curve.
///
/// Modes:
///   0 rev fee, the book keeps its spot/anchor ratio when the oracle moves
///   BASE the sliding 2%→0.3% schedule on every trade, no rev discount
///   A–D overshoot / relist, on the rev-fee book. Not in the V2 grid.
///   LEV  50/50 value mix. Not in the V2 grid.
///   DUTCH independent bid and ask. Each resets only when that side trades.
///   DRIP once an hour, a dutch sale of surplus coin funded only by fees, on the rev book.
///   DUTCHBASE shared-reset Dutch quotes plus the sliding fee and no rev discount.
///   COMBO shared-reset Dutch, the rev fee charged on top of the gap, and the 5×→1.2×
///        LP boost. This is the primary V2 variant. A search may retune its knobs.
///   COMBOALT the same book, but the rev fee is subtracted from the gap and is not also
///        charged on the fill.
///
/// V2 (`test_simV2`) is a different experiment from `SIM_RESULTS_PARTIAL.md`. The anchor
/// mean-reverts around $1. Daily organic volume is max(base, k × TVL). The objective is
/// the first day status turns on, then TVL at day 365. Status uses one threshold, 100% of
/// the live target, and the fixed 77-minute window in both directions. Crossing back clears
/// the clock. The main reference is fixed at $721k. One path grows it to $1M and one shrinks
/// it to $500k. Searcher profit has to stay positive in every progress bucket occupied while
/// status is off, including after an ungraduation: 0–10%, 10–30%, 30–60%, and 60–100%.
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
    uint8 internal constant MODE_DUTCH_BASE = 9;
    uint8 internal constant MODE_COMBO = 10;
    uint8 internal constant MODE_COMBO_ALT = 11;
    uint256 internal constant REV_HALF = 1 hours;
    uint256 internal constant REV_RED = 0.5e18;
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

    /// @dev Running champion inside the knob search. Fields live in memory-backed storage so the
    ///      search loop does not hold them all on the stack.
    struct Cand {
        uint256 drift;
        uint256 edge;
        uint256 red;
        uint256 boost;
        uint256 tiny;
        uint256 tvl;
        uint256 grad;
        uint256 fails;
        bool ok;
        bool seeded;
    }

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
    uint256 internal kWad;
    uint8 internal refPath;
    uint256 internal driftPerSec;
    uint256 internal edgeWad;
    uint256 internal redLineWad;
    uint256 internal boostStartWad;
    uint256 internal feeTinyBps;
    uint256 internal feeGradBps;
    uint256 internal aboveSince;
    uint256 internal belowSince;
    uint256 internal offN;
    DiscipleEngine internal engine;
    uint256 internal bucketClock;
    /// @dev Bucket the pool was in at the start of the current interval. 4 means "do not record".
    uint256 internal openBucket;
    int256[4] internal bucketP;
    uint256[4] internal bucketS;
    /// @dev Best COMBO knobs for k = 0.25, 0.5, and 1, from the active fixed-reference search.
    uint256[3] internal pickDrift;
    uint256[3] internal pickEdge;
    uint256[3] internal pickRed;
    uint256[3] internal pickBoost;
    uint256[3] internal pickTiny;
    bool[3] internal pickAlt;
    Cand internal cand;

    function setUp() public {
        engine = new DiscipleEngine();
    }

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
        // The fee is only the progress slide. On a $77 book against an $86.5k target it is
        // about 2%, and a lot sized off that slack walks through the discount, so the mark
        // is not positive. Fund the book to the target so the fee is the 0.3% end.
        s.y += 20e18 + GRAD;
        s.protoY += 20e18 + GRAD;
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

    /// @dev A reference that outgrows the pool turns status off after the window. A later shrink turns it back on.
    function test_statusTurnsOffWhenTheReferenceOutgrowsThePool() public {
        _reset(COST_OUTSIDE, MODE_BASE, VOL_ACTIVE, false);
        s.y = GRAD;
        s.anchor = 1e18;
        graduated = true;
        gradDay = 1;
        refPath = 1;
        clock = 300 days;
        _touchGrad();
        assertTrue(graduated, "the first reading under the target starts the off-window");
        clock += C.GRADUATION_WINDOW - 1 minutes;
        _touchGrad();
        assertTrue(graduated, "inside the window, status stays on");
        clock += 2 minutes;
        _touchGrad();
        assertFalse(graduated, "a full window under a grown reference turns status off");
        assertEq(offN, 1);

        refPath = 2;
        clock = 365 days;
        _touchGrad();
        assertFalse(graduated, "the first reading back over the target starts the on-window");
        clock += C.GRADUATION_WINDOW;
        _touchGrad();
        assertTrue(graduated, "a shrunk reference re-graduates the same pool");
        assertEq(offN, 1);
        assertEq(gradDay, 1, "grad day stays the first time status turned on");
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
        _profile("ACT", "OUT", "COMBO", COST_OUTSIDE, MODE_COMBO, VOL_ACTIVE, false);
        _profile("ACT", "OUT", "COMBOALT", COST_OUTSIDE, MODE_COMBO_ALT, VOL_ACTIVE, false);
        _profile("DEAD", "LOW", "DRIP", COST_LOW, MODE_DRIP, VOL_DEAD, true);
    }

    /// @dev Full V2 grid. Skipped unless `SIM_V2=1`, so `forge test` does not run the year.
    ///      `SIM_DAYS` shortens every profile. The knob search uses at most 240 days, long enough
    ///      to see graduation on the active book.
    function test_simV2() public {
        if (vm.envOr("SIM_V2", uint256(0)) == 0) {
            vm.skip(true);
            return;
        }
        uint256 saved = horizon;
        try vm.envUint("SIM_DAYS") returns (uint256 d) {
            if (d != 0) horizon = d;
        } catch {}
        saved = horizon;
        _pickCombo();
        horizon = saved;
        _v2Grid();
    }

    function _v2Grid() internal {
        uint8[7] memory modes = [MODE_COMBO, MODE_COMBO_ALT, MODE_BASE, 0, MODE_DUTCH, MODE_DRIP, MODE_DUTCH_BASE];
        string[7] memory names = ["COMBO", "COMBOALT", "BASE", "REV", "DUTCH", "DRIP", "DUTCHBASE"];
        uint256[3] memory ks = [uint256(0.25e18), uint256(0.5e18), uint256(1e18)];
        string[3] memory kName = ["k0.25", "k0.50", "k1.00"];
        string[3] memory refName = ["FIX", "GROW", "SHRINK"];
        for (uint256 v; v < modes.length; ++v) {
            for (uint256 s_; s_ < 2; ++s_) {
                bool dead_ = s_ == 1;
                string memory scene = dead_ ? "DEAD" : "ACT";
                uint256 vol = dead_ ? VOL_DEAD : VOL_ACTIVE;
                for (uint256 ki; ki < ks.length; ++ki) {
                    uint8 mode_ = modes[v];
                    if (v == 0) mode_ = pickAlt[ki] ? MODE_COMBO_ALT : MODE_COMBO;
                    else if (v == 1) mode_ = pickAlt[ki] ? MODE_COMBO : MODE_COMBO_ALT;
                    for (uint256 r; r < 3; ++r) {
                        _profileV2(scene, names[v], mode_, vol, dead_, ks[ki], kName[ki], uint8(r), refName[r], ki);
                    }
                }
            }
        }
    }

    function _profileV2(
        string memory scene,
        string memory variant,
        uint8 mode_,
        uint256 vol,
        bool dead_,
        uint256 k,
        string memory kName,
        uint8 ref_,
        string memory refName,
        uint256 ki
    ) internal {
        tag = string.concat(scene, " OUT ", variant, " ", kName, " ", refName);
        _reset(COST_OUTSIDE, mode_, vol, dead_);
        kWad = k;
        refPath = ref_;
        if (mode_ == MODE_COMBO || mode_ == MODE_COMBO_ALT) _applyPick(ki);
        _run();
        if (mode_ == MODE_DRIP) assertLe(dripSubsidy, fees, "drip subsidy stays inside fees");
        assertGe(s.x, s.seedFloor, "seed guard holds");
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
        if (_dutchFamily(mode_)) BridgeCurve.retarget(m, START);
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
        kWad = 0;
        refPath = 0;
        driftPerSec = DUTCH_PER_SEC;
        edgeWad = DUTCH_EDGE;
        redLineWad = REV_RED;
        boostStartWad = C.BOOST_START_WAD;
        feeTinyBps = C.FEE_TINY_BPS;
        feeGradBps = C.FEE_GRAD_BPS;
        aboveSince = 0;
        belowSince = 0;
        offN = 0;
        bucketClock = 0;
        openBucket = 0;
        for (uint256 i; i < 4; ++i) {
            bucketP[i] = 0;
            bucketS[i] = 0;
        }
    }

    function _dutchFamily(uint8 mode_) internal pure returns (bool) {
        return mode_ == MODE_DUTCH || mode_ == MODE_DUTCH_BASE || mode_ == MODE_COMBO || mode_ == MODE_COMBO_ALT;
    }

    function _sharedDutch() internal view returns (bool) {
        return mode == MODE_DUTCH_BASE || mode == MODE_COMBO || mode == MODE_COMBO_ALT;
    }

    function _run() internal {
        for (uint256 day = 1; day <= horizon; ++day) {
            // Each day is its own call so the EVM frees that day's curve copies. A year of
            // profiles in one call grows memory until MemoryLimitOOG.
            this.runDay();
            if (drainDay == 0 && BridgeCurve.tvl(s) < SEED / 2) drainDay = day;
            if (day == 7 || day == 30 || day == 90 || day == 365) _milestone(day);
            else if (day == horizon) _milestone(day);
        }
    }

    /// @dev One retail day. External so the memory used by the clips dies with the call.
    function runDay() external {
        require(msg.sender == address(this));
        uint256 budget = _budgetForDay();
        _lpInflow(budget);
        uint256 vol;
        uint256 guard;
        uint256 guardMax = kWad == 0 ? 500 : 24;
        while (vol < budget && guard < guardMax) {
            unchecked {
                ++guard;
            }
            uint256 amt = kWad == 0 ? 5e18 + (_rnd() % (45e18 + 1)) : budget / 24;
            if (amt == 0) amt = budget - vol;
            if (vol + amt > budget) amt = budget - vol;
            if (amt == 0) break;
            uint256 step = (1 days * amt) / budget;
            if (step == 0) step = 1;
            clock += step;
            _moveAnchor(step);
            _decayOvershoot();
            // A shared-reset quote is zero after the clip's own trade. Sample the gap that has
            // been open since the previous clip, and let the searcher take it before retail.
            if (_dutchFamily(mode)) {
                _recordGap();
                arbNotional += _arb();
            }
            bool buy = _rnd() % 2 == 0;
            if (!buy && s.y < 1e18) buy = true;
            if (buy) _routeBuy(amt, ACT_RETAIL);
            else _routeSell(Math.mulDiv(amt, C.WAD, _spot() == 0 ? s.anchor : _spot()), ACT_RETAIL);
            _relist(buy);
            vol += amt;
            if (!_dutchFamily(mode)) {
                _recordGap();
                _attack();
                arbNotional += _arb();
                _drip();
            }
            // Status flips before the bucket clock moves. Completing the on-window is still
            // pre-graduation and is recorded. Completing the off-window happens while the open
            // bucket is "graduated", so that interval is not recorded; later intervals are.
            _touchGrad();
            _noteTime();
        }
    }

    function _budgetForDay() internal view returns (uint256) {
        uint256 base = dead ? 150e18 : DAILY_ACTIVE;
        if (kWad == 0) return base;
        uint256 scaled = Math.mulDiv(BridgeCurve.tvl(s), kWad, C.WAD);
        return scaled > base ? scaled : base;
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
            vm.toString(gapN),
            " on ",
            graduated ? "1" : "0",
            " offN ",
            vm.toString(offN),
            " b0 ",
            vm.toString(bucketP[0]),
            " b1 ",
            vm.toString(bucketP[1]),
            " b2 ",
            vm.toString(bucketP[2]),
            " b3 ",
            vm.toString(bucketP[3]),
            " s0 ",
            vm.toString(bucketS[0]),
            " s1 ",
            vm.toString(bucketS[1]),
            " s2 ",
            vm.toString(bucketS[2]),
            " s3 ",
            vm.toString(bucketS[3])
        );
        console2.log(line);
    }

    function _routeBuy(uint256 usdgIn, uint8 actor) internal returns (uint256) {
        if (_dutchFamily(mode)) return _dutchBuy(usdgIn, actor);
        return _applyBuy(usdgIn, actor);
    }

    function _routeSell(uint256 dx, uint8 actor) internal returns (uint256) {
        if (_dutchFamily(mode)) return _dutchSell(dx, actor);
        return _applySell(dx, actor);
    }

    function _recordGap() internal {
        if (_dutchFamily(mode)) {
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
        if (_dutchFamily(mode)) return _arbDutch();
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
        if (_sharedDutch()) return _arbShared();
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

    /// @dev One clock. A fill resets both quotes, so a timestamp can take only one side.
    function _arbShared() internal returns (uint256) {
        uint256 raw = _dutchGap(bidAt);
        if (raw == 0) return 0;
        uint256 size = _dutchOffer(raw);
        if (size == 0) return 0;
        uint256 quoted = _priceGap(raw, size);
        if (quoted == 0) return 0;
        uint256 need = mode == MODE_COMBO_ALT ? _baseFee(BridgeCurve.tvl(s), _target()) * 1e14 + costWad : _slack(size);
        if (quoted <= need) return 0;
        uint256 coinVal = Math.mulDiv(s.x, s.anchor, C.WAD);
        if (s.y > 1e18 && coinVal < s.y) {
            uint256 px = Math.mulDiv(s.anchor, C.WAD + _dutchBidGap(quoted), C.WAD);
            uint256 dx = Math.mulDiv(size, C.WAD, px);
            if (dx > 0) return _dutchSell(dx, ACT_ARB);
        }
        return _dutchBuy(size, ACT_ARB);
    }

    function _clears(uint256 p, uint256 notion, bool buying) internal view returns (bool) {
        uint256 slack = _slack(notion);
        if (slack >= C.WAD || s.anchor == 0) return false;
        if (buying) return p < Math.mulDiv(s.anchor, C.WAD - slack, C.WAD);
        return p > s.anchor + Math.mulDiv(s.anchor, slack, C.WAD);
    }

    function _slack(uint256 notion) internal view returns (uint256) {
        return _fillBps(notion) * 1e14 + costWad;
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
        uint256 band = _preGradBucket();
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
        _stampShared();
        int256 mark = int256(Math.mulDiv(f.coinOut, s.anchor, C.WAD)) - int256(f.usdgIn);
        lastMark = mark;
        _attribute(actor, mark, f.usdgIn, band);
        if (actor == ACT_LOOP) attackerHold += f.coinOut;
        return f.usdgIn;
    }

    function _applySell(uint256 dx, uint8 actor) internal returns (uint256 filled) {
        if (dx == 0) return 0;
        uint256 band = _preGradBucket();
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
        _stampShared();
        int256 mark;
        if (f.coinIn > 0) {
            mark = int256(f.usdgOut) - int256(Math.mulDiv(f.coinIn, s.anchor, C.WAD));
            _attribute(actor, mark, gross, band);
            if (actor == ACT_LOOP) attackerHold = attackerHold > f.coinIn ? attackerHold - f.coinIn : 0;
        }
        lastMark = mark;
        return f.usdgOut;
    }

    function _attribute(uint8 actor, int256 mark, uint256 gross, uint256 band) internal {
        if (actor == ACT_ARB) {
            arbMark += mark;
            int256 profit = mark - int256(Math.mulDiv(gross, costWad, C.WAD));
            arbProfit += profit;
            if (band < 4) bucketP[band] += profit;
        } else if (actor == ACT_LOOP) {
            loopMark += mark;
            loopProfit += mark - int256(Math.mulDiv(gross, COST_LOW, C.WAD));
            loopNotional += gross;
        } else if (actor == ACT_RETAIL && _dutchFamily(mode)) {
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
        // A–D are the overshoot loop. LEV is the restoring loop. Every other book, including
        // COMBO, is quoted only by the retail flow and the single OUT searcher.
        if (mode != MODE_A && mode != MODE_B && mode != MODE_C && mode != MODE_D && mode != MODE_LEV) return;
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
        return (clock - since) * driftPerSec;
    }

    /// @dev Numerical floor for the bid price only. A quote cannot print below zero.
    function _dutchBidGap(uint256 gap) internal pure returns (uint256) {
        return gap > 0.99e18 ? 0.99e18 : gap;
    }

    /// @dev Same cap as `BridgeFee.dutchCap`: the safety cap, scaled down to 20% at the live target.
    function _dutchOffer(uint256 gap) internal view returns (uint256) {
        if (gap == 0) return 0;
        uint256 offered = Math.mulDiv(edgeWad, C.WAD, gap);
        uint256 cap = BridgeFee.dutchCap(BridgeCurve.tvl(s), _target());
        if (offered > cap) offered = cap;
        return offered;
    }

    function _dutchBuy(uint256 usdgIn, uint8 actor) internal returns (uint256 filled) {
        uint256 gap = _dutchGap(bidAt);
        uint256 offered = gap == 0 ? 0 : _dutchOffer(gap);
        uint256 quoted = _priceGap(gap, offered);
        if (gap > 0 && offered > 0 && quoted > 0 && (actor == ACT_RETAIL || quoted > _dutchNeed(offered))) {
            uint256 slice = usdgIn < offered ? usdgIn : offered;
            uint256 bid = Math.mulDiv(s.anchor, C.WAD - _dutchBidGap(quoted), C.WAD);
            if (bid == 0) bid = 1;
            _setSpot(bid);
            filled = _applyBuy(slice, actor);
            bidAt = clock;
            if (_sharedDutch()) askAt = clock;
            _setSpot(s.anchor);
            if (actor == ACT_RETAIL && usdgIn > slice) filled += _applyBuy(usdgIn - slice, actor);
            return filled;
        }
        return _applyBuy(usdgIn, actor);
    }

    function _dutchSell(uint256 dx, uint8 actor) internal returns (uint256 filled) {
        uint256 gap = _dutchGap(askAt);
        uint256 offered = gap == 0 ? 0 : _dutchOffer(gap);
        uint256 quoted = _priceGap(gap, offered);
        if (
            gap > 0 && offered > 0 && quoted > 0 && (actor == ACT_RETAIL || quoted > _dutchNeed(offered))
                && s.anchor != 0
        ) {
            uint256 ask = Math.mulDiv(s.anchor, C.WAD + quoted, C.WAD);
            uint256 maxDx = Math.mulDiv(offered, C.WAD, ask);
            uint256 slice = dx < maxDx ? dx : maxDx;
            if (slice == 0) return _applySell(dx, actor);
            _setSpot(ask);
            filled = _applySell(slice, actor);
            askAt = clock;
            if (_sharedDutch()) bidAt = clock;
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

    /// @dev Ornstein-Uhlenbeck around $1. Log-deviation half-life is 7 days, so there is no trend.
    ///      The shock is the same daily volatility as the old walk (3% active, 0.1% dead).
    function _moveAnchor(uint256 dt) internal {
        if (dt == 0 || volWad == 0 || s.anchor == 0) return;
        int256 logP = _lnWad(s.anchor);
        uint256 mag = uint256(logP < 0 ? -logP : logP);
        uint256 left = BridgeFee.decayed(mag, dt, 7 days);
        int256 pulled = logP < 0 ? -int256(left) : int256(left);
        int256 z = _gauss();
        uint256 uWad = Math.mulDiv(dt, C.WAD, 1 days);
        uint256 sqrtU = Math.sqrt(uWad * C.WAD);
        int256 shock = z * int256(volWad) / int256(C.WAD);
        shock = shock * int256(sqrtU) / int256(C.WAD);
        if (shock > 0.2e18) shock = 0.2e18;
        if (shock < -0.2e18) shock = -0.2e18;
        int256 nextLog = pulled + shock;
        if (nextLog > 0.7e18) nextLog = 0.7e18;
        if (nextLog < -0.7e18) nextLog = -0.7e18;
        uint256 next = _expWad(nextLog);
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
        if (_dutchFamily(mode)) {
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
        return BridgeFee.decayed(revVolume, dt, REV_HALF);
    }

    /// @dev The searched knob is the red line at 100% progress. At 0% it is a quarter of that,
    ///      so the same volume intensity collects more of the cap while progress is low. The cap
    ///      itself is the live progress slide. A larger reference lowers progress, tightens the
    ///      line, and raises the cap together.
    function _redLine() internal view returns (uint256) {
        uint256 knob = redLineWad == 0 ? REV_RED : redLineWad;
        uint256 target = _target();
        uint256 v = BridgeCurve.tvl(s);
        uint256 progress = target == 0 ? 0 : (v >= target ? C.WAD : Math.mulDiv(v, C.WAD, target));
        uint256 floorLine = knob / 4;
        if (floorLine == 0) floorLine = 1;
        return floorLine + Math.mulDiv(knob - floorLine, progress, C.WAD);
    }

    /// @dev Quiet floor 30 bps, up to the sliding cap once decayed volume reaches the red line.
    function _revBps(uint256 extra) internal view returns (uint256) {
        uint256 v = BridgeCurve.tvl(s);
        uint256 cap = _baseFee(v, _target());
        if (cap <= C.FEE_FLOOR_BPS) return C.FEE_FLOOR_BPS;
        uint256 denom = v == 0 ? 1 : v;
        uint256 red = _redLine();
        uint256 intensity = Math.mulDiv(_decayedVol() + extra, C.WAD, denom);
        if (intensity >= red) return cap;
        return C.FEE_FLOOR_BPS + Math.mulDiv(cap - C.FEE_FLOOR_BPS, intensity, red);
    }

    function _chargesRev() internal view returns (bool) {
        return mode == 0 || mode == MODE_DUTCH || mode == MODE_DRIP || mode == MODE_COMBO;
    }

    function _fillBps(uint256 extra) internal view returns (uint256) {
        if (mode == MODE_COMBO_ALT) return 0;
        if (_chargesRev()) return _revBps(extra);
        return _baseFee(BridgeCurve.tvl(s), _target());
    }

    function _ctx(BridgeCurve.S memory m) internal view returns (BridgeCurve.Ctx memory c) {
        c.gradTvl = _target();
        c.floorBps = C.FLOOR_BPS;
        c.maxUsdgOut = type(uint256).max;
        c.boostWad = _boostAt(BridgeCurve.tvl(m));
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

    function _dutchNeed(uint256 notion) internal view returns (uint256) {
        if (mode == MODE_COMBO_ALT) return _baseFee(BridgeCurve.tvl(s), _target()) * 1e14 + costWad;
        return _slack(notion);
    }

    /// @dev COMBO-alt quotes a tighter gap and does not also charge the rev fee.
    function _priceGap(uint256 raw, uint256 notion) internal view returns (uint256) {
        if (mode != MODE_COMBO_ALT || raw == 0) return raw;
        uint256 feeWad = _revBps(notion) * 1e14;
        return raw > feeWad ? raw - feeWad : 0;
    }

    function _refTvl() internal view returns (uint256) {
        if (refPath == 0) return REF_TVL;
        uint256 day = clock / 1 days;
        if (day > 365) day = 365;
        if (refPath == 1) return REF_TVL + ((1_000_000e18 - REF_TVL) * day) / 365;
        uint256 drop = ((REF_TVL - 500_000e18) * day) / 365;
        return REF_TVL > drop ? REF_TVL - drop : 500_000e18;
    }

    function _target() internal view returns (uint256) {
        return (_refTvl() * 12) / 100;
    }

    function _baseFee(uint256 tvl, uint256 grad) internal view returns (uint256) {
        uint256 hi = feeTinyBps == 0 ? C.FEE_TINY_BPS : feeTinyBps;
        uint256 lo = feeGradBps == 0 ? C.FEE_GRAD_BPS : feeGradBps;
        if (hi < lo) hi = lo;
        if (grad == 0 || tvl >= grad) return grad == 0 ? hi : lo;
        return lo + ((hi - lo) * (grad - tvl)) / grad;
    }

    function _boostAt(uint256 v) internal view returns (uint256) {
        uint256 start = boostStartWad == 0 ? C.BOOST_START_WAD : boostStartWad;
        uint256 end = C.BOOST_END_WAD;
        if (start < end) start = end;
        uint256 grad = _target();
        if (grad == 0 || v >= grad) return grad == 0 ? start : end;
        return end + ((start - end) * (grad - v)) / grad;
    }

    function _boost() internal view returns (uint256) {
        return _boostAt(BridgeCurve.tvl(s));
    }

    /// @dev Progress buckets while status is off: 0–10%, 10–30%, 30–60%, and 60% through the
    ///      moment status turns on, including time above the live target. After an ungraduation
    ///      the same buckets resume. Index 4 is not recorded.
    function _preGradBucket() internal view returns (uint256) {
        if (graduated) return 4;
        uint256 target = _target();
        if (target == 0) return 0;
        uint256 progress = Math.mulDiv(BridgeCurve.tvl(s), C.WAD, target);
        if (progress < 0.1e18) return 0;
        if (progress < 0.3e18) return 1;
        if (progress < 0.6e18) return 2;
        return 3;
    }

    function _noteTime() internal {
        uint256 dt = bucketClock == 0 || clock <= bucketClock ? 0 : clock - bucketClock;
        bucketClock = clock;
        if (dt > 0 && openBucket < 4) bucketS[openBucket] += dt;
        openBucket = _preGradBucket();
    }

    /// @dev External LP so the boost knob can move TVL. Fee-split weight alone cannot, because both
    ///      sides compound in the same book. Inflow is `budget * (boost - 1) / 5 / 5`. At 5× that is
    ///      16% of the day's organic budget. It is added as coin while spot is under the anchor, and
    ///      as USDG otherwise. Every mode gets it. Only COMBO's search changes the 5× start.
    function _lpInflow(uint256 budget) internal {
        if (budget == 0 || s.anchor == 0) return;
        uint256 b = _boost();
        if (b <= C.WAD) return;
        uint256 usdgIn = Math.mulDiv(budget, b - C.WAD, 5 * C.WAD) / 5;
        if (usdgIn == 0) return;
        if (_spot() < s.anchor) {
            uint256 coin = Math.mulDiv(usdgIn, C.WAD, s.anchor);
            s.x += coin;
            s.lpX += coin;
        } else {
            s.y += usdgIn;
            s.lpY += usdgIn;
        }
    }

    /// @dev Same machine as `DiscipleEngine.stepGrad`, on the sim clock and the fixed 77-minute window.
    ///      Fee, boost, and Dutch size keep using live progress either way.
    ///      `gradDay` stays the first day status turns on. `offN` counts later turns off.
    function _touchGrad() internal {
        uint8 edge;
        uint64 above;
        uint64 below;
        (graduated, above, below, edge) =
            engine.stepGrad(BridgeCurve.tvl(s), _target(), graduated, uint64(aboveSince), uint64(belowSince), clock);
        aboveSince = above;
        belowSince = below;
        if (edge == 1 && gradDay == 0) gradDay = _dayNow();
        if (edge == 2) offN += 1;
    }

    function _dayNow() internal view returns (uint256) {
        if (clock == 0) return 1;
        uint256 d = clock / 1 days;
        if (clock % 1 days != 0) d += 1;
        return d == 0 ? 1 : d;
    }

    function _applyPick(uint256 ki) internal {
        if (pickDrift[ki] != 0) driftPerSec = pickDrift[ki];
        if (pickEdge[ki] != 0) edgeWad = pickEdge[ki];
        if (pickRed[ki] != 0) redLineWad = pickRed[ki];
        if (pickBoost[ki] != 0) boostStartWad = pickBoost[ki];
        if (pickTiny[ki] != 0) feeTinyBps = pickTiny[ki];
    }

    /// @dev Occupied buckets with searcher profit at or below zero. Time while status is on is
    ///      not counted. Time after an ungraduation is.
    function _fails() internal view returns (uint256 n) {
        for (uint256 i; i < 4; ++i) {
            if (bucketS[i] > 0 && bucketP[i] <= 0) ++n;
        }
    }

    /// @dev A shared-reset fill parks both quotes. Independent Dutch (MODE_DUTCH) resets only the
    ///      side that was quoted, inside `_dutchBuy` / `_dutchSell`.
    function _stampShared() internal {
        if (!_sharedDutch()) return;
        bidAt = clock;
        askAt = clock;
    }

    function _cfg(uint256 i)
        internal
        pure
        returns (uint256 drift, uint256 edge, uint256 red, uint256 boost, uint256 tiny)
    {
        drift = DUTCH_PER_SEC;
        edge = DUTCH_EDGE;
        red = REV_RED;
        boost = C.BOOST_START_WAD;
        tiny = C.FEE_TINY_BPS;
        if (i == 1) drift = uint256(0.005e18) / 1 hours;
        else if (i == 2) drift = uint256(0.02e18) / 1 hours;
        else if (i == 11) drift = uint256(0.05e18) / 1 hours;
        else if (i == 12) drift = uint256(0.1e18) / 1 hours;
        else if (i == 3) edge = 0.1e18;
        else if (i == 4) edge = 0.5e18;
        else if (i == 5) red = 0.25e18;
        else if (i == 6) red = 1e18;
        else if (i == 7) boost = 3e18;
        else if (i == 8) boost = 8e18;
        else if (i == 9) tiny = 100;
        else if (i == 10) tiny = 300;
    }

    /// @dev For each k, minimize days to the first graduation on the active fixed-reference book.
    ///      A set counts only when every occupied off-status progress bucket has searcher profit
    ///      above zero, including buckets reopened by an ungraduation. Otherwise keep the one with
    ///      fewer failing buckets. The netted quote is scored at the winning knobs and becomes
    ///      COMBO when it graduates sooner under the same rule.
    function _pickCombo() internal {
        uint256 keep = horizon;
        horizon = keep < 240 ? keep : 240;
        uint256[3] memory ks = [uint256(0.25e18), uint256(0.5e18), uint256(1e18)];
        for (uint256 ki; ki < 3; ++ki) {
            _searchK(ki, ks[ki]);
        }
        horizon = keep;
    }

    function _searchK(uint256 ki, uint256 k) internal {
        cand.seeded = false;
        cand.ok = false;
        cand.fails = type(uint256).max;
        cand.grad = 0;
        cand.tvl = 0;
        cand.drift = DUTCH_PER_SEC;
        cand.edge = DUTCH_EDGE;
        cand.red = REV_RED;
        cand.boost = C.BOOST_START_WAD;
        cand.tiny = C.FEE_TINY_BPS;
        for (uint256 i; i < 13; ++i) {
            (uint256 drift, uint256 edge, uint256 red, uint256 boost, uint256 tiny) = _cfg(i);
            _try(k, i, "ontop", drift, edge, red, boost, tiny);
        }
        _refine(k);
        (uint256 altTvl, bool altOk, uint256 altGrad, uint256 altFails) =
            _score(true, k, cand.drift, cand.edge, cand.red, cand.boost, cand.tiny);
        _logPick(
            "netted", k, 0, altTvl, altOk, altGrad, altFails, cand.drift, cand.edge, cand.red, cand.boost, cand.tiny
        );
        bool altWins = _prefers(altOk, altFails, altGrad, altTvl, cand.ok, cand.fails, cand.grad, cand.tvl, true);
        pickDrift[ki] = cand.drift;
        pickEdge[ki] = cand.edge;
        pickRed[ki] = cand.red;
        pickBoost[ki] = cand.boost;
        pickTiny[ki] = cand.tiny;
        pickAlt[ki] = altWins;
        uint256 winTvl = altWins ? altTvl : cand.tvl;
        bool winOk = altWins ? altOk : cand.ok;
        uint256 winGrad = altWins ? altGrad : cand.grad;
        uint256 winFails = altWins ? altFails : cand.fails;
        console2.log(
            string.concat(
                "PICK winner k ",
                vm.toString(k),
                " ",
                altWins ? "netted" : "ontop",
                " tvl ",
                vm.toString(winTvl),
                " ok ",
                winOk ? "1" : "0",
                " grad ",
                vm.toString(winGrad),
                " fails ",
                vm.toString(winFails),
                " drift ",
                vm.toString(cand.drift),
                " edge ",
                vm.toString(cand.edge),
                " red ",
                vm.toString(cand.red),
                " boost ",
                vm.toString(cand.boost),
                " tiny ",
                vm.toString(cand.tiny)
            )
        );
    }

    /// @dev One coordinate at a time, starting from the current champion. Drift is last so it is
    ///      rechecked after the other knobs have moved.
    function _refine(uint256 k) internal {
        for (uint256 n; n < 5; ++n) {
            uint256 axis = n == 4 ? 0 : n + 1;
            uint256 bd = cand.drift;
            uint256 be = cand.edge;
            uint256 br = cand.red;
            uint256 bb = cand.boost;
            uint256 bt = cand.tiny;
            for (uint256 j; j < 5; ++j) {
                (uint256 value, bool live) = _axis(axis, j);
                if (!live) continue;
                uint256 drift = bd;
                uint256 edge = be;
                uint256 red = br;
                uint256 boost = bb;
                uint256 tiny = bt;
                if (axis == 0) {
                    if (value == bd) continue;
                    drift = value;
                } else if (axis == 1) {
                    if (value == be) continue;
                    edge = value;
                } else if (axis == 2) {
                    if (value == br) continue;
                    red = value;
                } else if (axis == 3) {
                    if (value == bb) continue;
                    boost = value;
                } else {
                    if (value == bt) continue;
                    tiny = value;
                }
                _try(k, j, "refine", drift, edge, red, boost, tiny);
            }
        }
    }

    function _try(
        uint256 k,
        uint256 i,
        string memory which,
        uint256 drift,
        uint256 edge,
        uint256 red,
        uint256 boost,
        uint256 tiny
    ) internal {
        (uint256 tvl, bool ok, uint256 grad, uint256 fails) = _score(false, k, drift, edge, red, boost, tiny);
        _logPick(which, k, i, tvl, ok, grad, fails, drift, edge, red, boost, tiny);
        if (_prefers(ok, fails, grad, tvl, cand.ok, cand.fails, cand.grad, cand.tvl, cand.seeded)) {
            cand.seeded = true;
            cand.ok = ok;
            cand.fails = fails;
            cand.grad = grad;
            cand.tvl = tvl;
            cand.drift = drift;
            cand.edge = edge;
            cand.red = red;
            cand.boost = boost;
            cand.tiny = tiny;
        }
    }

    function _axis(uint256 axis, uint256 j) internal pure returns (uint256 value, bool live) {
        if (axis == 0) {
            if (j == 0) return (uint256(0.005e18) / 1 hours, true);
            if (j == 1) return (DUTCH_PER_SEC, true);
            if (j == 2) return (uint256(0.02e18) / 1 hours, true);
            if (j == 3) return (uint256(0.05e18) / 1 hours, true);
            if (j == 4) return (uint256(0.1e18) / 1 hours, true);
        } else if (axis == 1) {
            if (j == 0) return (uint256(0.1e18), true);
            if (j == 1) return (DUTCH_EDGE, true);
            if (j == 2) return (uint256(0.5e18), true);
        } else if (axis == 2) {
            if (j == 0) return (uint256(0.25e18), true);
            if (j == 1) return (REV_RED, true);
            if (j == 2) return (uint256(1e18), true);
        } else if (axis == 3) {
            if (j == 0) return (uint256(3e18), true);
            if (j == 1) return (C.BOOST_START_WAD, true);
            if (j == 2) return (uint256(8e18), true);
        } else if (axis == 4) {
            if (j == 0) return (uint256(100), true);
            if (j == 1) return (C.FEE_TINY_BPS, true);
            if (j == 2) return (uint256(300), true);
        }
        return (0, false);
    }

    function _logPick(
        string memory which,
        uint256 k,
        uint256 i,
        uint256 tvl,
        bool ok,
        uint256 grad,
        uint256 fails,
        uint256 drift,
        uint256 edge,
        uint256 red,
        uint256 boost,
        uint256 tiny
    ) internal pure {
        console2.log(
            string.concat(
                "PICKCFG ",
                which,
                " k ",
                vm.toString(k),
                " i ",
                vm.toString(i),
                " tvl ",
                vm.toString(tvl),
                " ok ",
                ok ? "1" : "0",
                " grad ",
                vm.toString(grad),
                " fails ",
                vm.toString(fails),
                " drift ",
                vm.toString(drift),
                " edge ",
                vm.toString(edge),
                " red ",
                vm.toString(red),
                " boost ",
                vm.toString(boost),
                " tiny ",
                vm.toString(tiny)
            )
        );
    }

    /// @dev A solvent set beats a violation. Fewer failing buckets is the closest violation.
    ///      Within that, earlier graduation, then higher TVL.
    function _prefers(
        bool ok,
        uint256 fails,
        uint256 grad,
        uint256 tvl,
        bool bestOk,
        uint256 bestFails,
        uint256 bestGrad,
        uint256 bestTvl,
        bool seeded
    ) internal pure returns (bool) {
        if (!seeded) return true;
        if (ok != bestOk) return ok;
        if (!ok && fails != bestFails) return fails < bestFails;
        return _growthBetter(grad, tvl, bestGrad, bestTvl);
    }

    /// @dev Graduation is the objective. A profile that reaches it beats one that does not.
    ///      Otherwise the higher TVL is closer to the target.
    function _growthBetter(uint256 grad, uint256 tvl, uint256 otherGrad, uint256 otherTvl)
        internal
        pure
        returns (bool)
    {
        bool reached = grad != 0;
        bool otherReached = otherGrad != 0;
        if (reached != otherReached) return reached;
        if (reached && grad != otherGrad) return grad < otherGrad;
        return tvl > otherTvl;
    }

    function _score(bool alt, uint256 k, uint256 drift, uint256 edge, uint256 red, uint256 boost, uint256 tiny)
        internal
        returns (uint256 tvl, bool ok, uint256 grad, uint256 fails)
    {
        tag = "PICK";
        _reset(COST_OUTSIDE, alt ? MODE_COMBO_ALT : MODE_COMBO, VOL_ACTIVE, false);
        kWad = k;
        refPath = 0;
        driftPerSec = drift;
        edgeWad = edge;
        redLineWad = red;
        boostStartWad = boost;
        feeTinyBps = tiny;
        _run();
        fails = _fails();
        grad = gradDay;
        ok = fails == 0 && grad != 0;
        return (BridgeCurve.tvl(s), ok, grad, fails);
    }

    function _lnWad(uint256 x) internal pure returns (int256) {
        if (x == 0) return -1e18;
        if (x == C.WAD) return 0;
        if (x > C.WAD) return int256(_lnAbove(x));
        return -int256(_lnAbove(Math.mulDiv(C.WAD, C.WAD, x)));
    }

    function _lnAbove(uint256 x) internal pure returns (uint256) {
        if (x <= C.WAD) return 0;
        return Math.mulDiv(_log2Wad(x), C.LN2_WAD, C.WAD);
    }

    function _log2Wad(uint256 x) internal pure returns (uint256 result) {
        uint256 integer;
        while (x >= 2 * C.WAD) {
            x >>= 1;
            integer += C.WAD;
        }
        uint256 y = x;
        uint256 bit = C.WAD / 2;
        for (uint256 i; i < 40 && bit > 0; ++i) {
            y = Math.mulDiv(y, y, C.WAD);
            if (y >= 2 * C.WAD) {
                result += bit;
                y >>= 1;
            }
            bit >>= 1;
        }
        result += integer;
    }
}

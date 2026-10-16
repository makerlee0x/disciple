// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {TrampWallManager} from "../../src/TrampWallManager.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {IAltitudeEvents} from "../../src/interfaces/IAltitudeEvents.sol";
import {Altitude} from "../../src/libraries/Altitude.sol";
import {MarketLens} from "../../src/addons/MarketLens.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice SEC-02 (JIT) + SEC-03 (TWAP) + altitude-on-TWAP simulations.
contract JitTwapTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;

    TrampWallManager twm;
    BondingCurve curve;
    Token tok;
    PoolId pid;
    address alice = makeAddr("alice");
    address whale = makeAddr("whale");
    address jit = makeAddr("jit");

    function setUp() public override {
        super.setUp();
        twm = new TrampWallManager(manager, lockedLP, address(hook));
        hook.setLiquidityManager(address(twm), true);
        (curve, tok) = _launch(0, 0);
        _graduate(curve);
        pid = _poolKey(tok).toId();
        address[3] memory us = [alice, whale, jit];
        for (uint256 i; i < 3; i++) {
            quote.mint(us[i], 10_000_000 ether);
            deal(address(tok), us[i], 1_000_000_000 ether);
            vm.startPrank(us[i]);
            quote.approve(address(twm), type(uint256).max);
            tok.approve(address(twm), type(uint256).max);
            quote.approve(address(router), type(uint256).max);
            tok.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ───────────── helpers ─────────────

    function _next(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1);
    }

    function _buy(address u, uint256 amt) internal {
        vm.prank(u);
        router.buyExactIn(address(tok), amt, 0, u, block.timestamp + 1);
    }

    function _sell(address u, uint256 amt) internal {
        vm.prank(u);
        router.sellExactIn(address(tok), amt, 0, u, block.timestamp + 1);
    }

    function _tIs0() internal view returns (bool) {
        return uint160(address(tok)) < uint160(address(quote));
    }

    function _spotTokenTick() internal view returns (int24) {
        (int24 t,,,) = twm.poolState(address(tok));
        return _tIs0() ? t : -t;
    }

    function _floor(int24 t, int24 ts) internal pure returns (int24) {
        int24 c = t / ts;
        if (t < 0 && t % ts != 0) c--;
        return c * ts;
    }

    /// @dev quote-only (tramp) range just below the current price, `w` spacings wide.
    function _trampRange(int24 w) internal view returns (int24 lo, int24 hi) {
        (int24 tick,, int24 ts,) = twm.poolState(address(tok));
        int24 a = _floor(tick, ts);
        if (!_tIs0()) {
            // quote is c0 → quote-only range sits ABOVE the pool tick
            lo = a + ts;
            hi = lo + ts * w;
        } else {
            hi = a;
            lo = hi - ts * w;
        }
    }

    function _mcapSpot() internal view returns (uint256) {
        return curve.mcapNow();
    }

    function _countTierBreaks(Vm.Log[] memory logs, address emitter) internal pure returns (uint256 n, uint8 lastTo) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == IAltitudeEvents.TierBreak.selector) {
                n++;
                (, lastTo,) = abi.decode(logs[i].data, (uint8, uint8, uint256));
            }
        }
    }

    /// @dev Places a tramp just below price and sells the price into it (not through), all in this block.
    function _jitAroundSells(address lp) internal returns (uint256 id) {
        (int24 lo, int24 hi) = _trampRange(8);
        vm.prank(lp);
        (id,) = twm.placeTramp(address(tok), lo, hi, 50_000 ether, 0, block.timestamp + 1);
        for (uint256 i; i < 6; i++) {
            _sell(whale, 2_000_000 ether);
        }
        (uint256 q, uint256 t) = twm.pendingFees(id);
        require(q + t > 0, "range never earned");
        require(!twm.isFilled(id), "filled");
    }

    // ───────────── SEC-02: JIT ─────────────

    function test_jit_raw_v4_add_blocked_by_hook() public {
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        PoolKey memory key = _poolKey(tok);
        vm.startPrank(jit);
        quote.approve(address(lp), type(uint256).max);
        tok.approve(address(lp), type(uint256).max);
        vm.expectRevert();
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e18, salt: 0}),
            ""
        );
        vm.stopPrank();
        assertFalse(hook.isLiquidityManager(jit));
        assertTrue(hook.isLiquidityManager(address(lockedLP)));
    }

    function test_jit_same_block_cancel_and_pull_revert_hold() public {
        uint256 id = _jitAroundSells(jit);
        vm.prank(jit);
        vm.expectRevert(abi.encodeWithSelector(TrampWallManager.HoldActive.selector, block.timestamp + 300));
        twm.cancel(id);
        vm.expectRevert(); // NotFilled or HoldActive
        twm.pull(id);
    }

    function test_jit_add_swap_remove_one_block_earns_nothing() public {
        vm.prank(twm.owner());
        twm.setJitParams(0, 3600); // even with no hold, vesting zeroes same-block fees
        uint256 id = _jitAroundSells(jit);
        (uint256 pq, uint256 pt) = twm.pendingFees(id);
        uint256 tq0 = quote.balanceOf(treasury);
        uint256 tt0 = tok.balanceOf(treasury);
        (uint256 cq, uint256 ct) = twm.claimableFees(id);
        assertEq(cq + ct, 0, "nothing claimable at age 0");

        vm.recordLogs();
        vm.prank(jit);
        twm.cancel(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool forfeited;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == TrampWallManager.Cancelled.selector) {
                (,,,, uint256 qf, uint256 tf) =
                    abi.decode(logs[i].data, (int24, int24, uint256, uint256, uint256, uint256));
                assertEq(qf + tf, 0, "JIT fees paid");
            }
            if (logs[i].topics[0] == TrampWallManager.FeesForfeited.selector) forfeited = true;
        }
        assertTrue(forfeited);
        // every wei of accrued donation went to the treasury instead (±1 rounding)
        assertApproxEqAbs(quote.balanceOf(treasury) - tq0, pq, 1);
        assertApproxEqAbs(tok.balanceOf(treasury) - tt0, pt, 1);
    }

    function test_jit_fees_vest_linearly_and_fully_after_period() public {
        uint256 id = _jitAroundSells(alice);
        (uint256 pq, uint256 pt) = twm.pendingFees(id);
        _next(1800); // half vested
        assertEq(twm.vestedBps(id), 5000);
        (uint256 cq, uint256 ct) = twm.claimableFees(id);
        assertApproxEqAbs(cq, pq / 2, 1);
        assertApproxEqAbs(ct, pt / 2, 1);
        _next(1800); // fully vested
        uint256 q0 = quote.balanceOf(alice);
        uint256 t0 = tok.balanceOf(alice);
        uint256 tq0 = quote.balanceOf(treasury);
        vm.prank(alice);
        (uint256 fq, uint256 ft) = twm.claimFees(id);
        assertApproxEqAbs(fq, pq, 1);
        assertApproxEqAbs(ft, pt, 1);
        assertEq(quote.balanceOf(alice) - q0, fq);
        assertEq(tok.balanceOf(alice) - t0, ft);
        assertEq(quote.balanceOf(treasury), tq0, "no forfeit when vested");
    }

    function test_jit_honest_cancel_after_hold_partial_vest() public {
        uint256 id = _jitAroundSells(alice);
        (uint256 pq, uint256 pt) = twm.pendingFees(id);
        _next(300);
        uint256 tq0 = quote.balanceOf(treasury);
        uint256 tt0 = tok.balanceOf(treasury);
        vm.prank(alice);
        twm.cancel(id);
        // 300/3600 vested → ~91.7% forfeited
        uint256 forfeitQ = quote.balanceOf(treasury) - tq0;
        uint256 forfeitT = tok.balanceOf(treasury) - tt0;
        assertApproxEqAbs(forfeitQ, pq - pq * 833 / 10_000, pq / 1000 + 2);
        assertApproxEqAbs(forfeitT, pt - pt * 833 / 10_000, pt / 1000 + 2);
    }

    function test_jit_params_owner_only_and_bounded() public {
        vm.prank(alice);
        vm.expectRevert(TrampWallManager.OnlyOwner.selector);
        twm.setJitParams(1, 1);
        vm.expectRevert(TrampWallManager.BadParam.selector);
        twm.setJitParams(8 days, 1);
        twm.setJitParams(600, 7200);
        assertEq(twm.minHoldSeconds(), 600);
        assertEq(twm.feeVestSeconds(), 7200);
        vm.prank(alice);
        vm.expectRevert(DiscipleHook.OnlyAdmin.selector);
        hook.setLiquidityManager(alice, true);
    }

    // ───────────── SEC-03: TWAP manipulation ─────────────

    function _buildHistory() internal {
        for (uint256 i; i < 12; i++) {
            _next(60);
            _buy(alice, 1 ether);
        }
    }

    function test_twap_same_block_pump_and_dump_has_zero_weight() public {
        _buildHistory();
        _next(30);
        (int24 before,) = hook.twapTick(pid, 600);
        // flash pump + dump inside one block
        _buy(whale, 3_000_000 ether);
        assertGt(_spotTokenTick(), before + 5000, "pump moved spot");
        (int24 mid,) = hook.twapTick(pid, 600);
        assertEq(mid, before, "same-block pump moved TWAP");
        _sell(whale, tok.balanceOf(whale) / 2);
        (int24 afterDump,) = hook.twapTick(pid, 600);
        assertEq(afterDump, before, "same-block dump moved TWAP");
    }

    function test_twap_truncation_bounds_per_block_move() public {
        _buildHistory();
        _next(1);
        _buy(whale, 9_000_000 ether); // huge pump held into the next block
        int24 spot = _spotTokenTick();
        (,,, int24 lastBefore) = hook.oracleState(pid);
        _next(1);
        _buy(alice, 1 ether); // first swap of next block writes the (truncated) pump tick
        (,,, int24 lastAfter) = hook.oracleState(pid);
        assertGt(spot - lastBefore, hook.maxTickDelta(), "pump bigger than cap");
        assertEq(lastAfter - lastBefore, hook.maxTickDelta(), "recorded tick clamped");
    }

    function test_twap_follows_sustained_move() public {
        _buildHistory();
        _next(1);
        _buy(whale, 20_000 ether);
        int24 target = _spotTokenTick();
        for (uint256 i; i < 20; i++) {
            _next(60);
            _buy(alice, 1 ether);
        }
        (int24 t, uint32 w) = hook.twapTick(pid, 600);
        assertEq(w, 600);
        assertApproxEqAbs(int256(t), int256(target), 20, "TWAP converges on a held price");
    }

    function _refSwap(bool strategyIn, uint256 amt) internal {
        bool zeroForOne = strategyIn == (uint160(address(strategy)) < uint160(address(quote)));
        MockUSDG tin = strategyIn ? strategy : quote;
        tin.mint(address(this), amt);
        IERC20(address(tin)).approve(address(swapRouter), amt);
        swapRouter.swap(
            strategyUsdgKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_pricer_flash_manipulation_poke_and_launch_unchanged() public {
        _next(3600);
        pricer.poke(address(strategy));
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        // flash: pump STRATEGY 4x+ in the reference pool, poke, read, launch, all in one block
        _refSwap(false, 100_000 ether);
        assertGt(pricer.spotPriceUsd(address(strategy)), p0 * 3, "spot manipulated");
        pricer.poke(address(strategy));
        assertEq(pricer.quotePriceUsd(address(strategy)), p0, "TWAP moved in-block");
        (BondingCurve c2,) = _launchWithQuote(address(0), 0, 0); // default quote = STRATEGY; Launchpad pokes too
        assertEq(c2.quotePriceUsd(), p0, "curve baked manipulated price");
    }

    function test_pricer_sustained_move_is_rate_limited_then_tracks() public {
        _next(3600);
        pricer.poke(address(strategy));
        (int24 t0,) = pricer.twapTick(address(strategy));
        _refSwap(false, 100_000 ether); // held
        pricer.poke(address(strategy));
        _next(60);
        pricer.poke(address(strategy));
        (int24 t1,) = pricer.twapTick(address(strategy));
        // one 60s interval at ≤ +2000 ticks out of a 1800s window → ≤ 2000*60/1800 ≈ 67 ticks
        assertLe(t1 - t0, 68);
        for (uint256 i; i < 40; i++) {
            _next(60);
            pricer.poke(address(strategy));
        }
        uint256 p = pricer.quotePriceUsd(address(strategy));
        uint256 s = pricer.spotPriceUsd(address(strategy));
        assertApproxEqRel(p, s, 0.01e18, "TWAP tracks a sustained move");
    }

    function test_pricer_params_owner_only() public {
        vm.expectRevert(QuotePricer.OnlyOwner.selector);
        pricer.setTwapParams(60, 100);
        vm.startPrank(owner);
        vm.expectRevert(QuotePricer.BadParam.selector);
        pricer.setTwapParams(0, 100);
        pricer.setTwapParams(600, 500);
        vm.stopPrank();
        assertEq(pricer.twapWindow(), 600);
        assertEq(pricer.maxTickDelta(), 500);
    }

    // ───────────── Altitude on TWAP (post-grad, hook) ─────────────

    function test_altitude_hook_spot_spike_no_tier_break() public {
        _buildHistory();
        uint8 tier0 = hook.altitudeTierOf(pid);
        _next(30);
        vm.recordLogs();
        _buy(whale, 3_000_000 ether);
        assertGt(Altitude.tierOf(_mcapSpot()), tier0, "spike crosses tiers on spot");
        _sell(whale, tok.balanceOf(whale) / 2);
        (uint256 n,) = _countTierBreaks(vm.getRecordedLogs(), address(hook));
        assertEq(n, 0, "spot spike caused a TierBreak");
        assertEq(hook.altitudeTierOf(pid), tier0);
    }

    function test_altitude_hook_sustained_move_breaks_tier() public {
        _buildHistory();
        uint8 tier0 = hook.altitudeTierOf(pid);
        _next(1);
        _buy(whale, 20_000 ether);
        uint8 spotTier = Altitude.tierOf(_mcapSpot());
        assertGt(spotTier, tier0);
        vm.recordLogs();
        for (uint256 i; i < 25; i++) {
            _next(60);
            _buy(alice, 1 ether);
        }
        (uint256 n, uint8 lastTo) = _countTierBreaks(vm.getRecordedLogs(), address(hook));
        assertGt(n, 0, "no TierBreak after sustained move");
        assertEq(lastTo, spotTier);
        assertEq(hook.altitudeTierOf(pid), spotTier);
    }

    function test_altitude_window_settable() public {
        vm.prank(alice);
        vm.expectRevert(DiscipleHook.OnlyAdmin.selector);
        hook.setAltitudeWindow(60);
        vm.expectRevert(DiscipleHook.BadParam.selector);
        hook.setAltitudeWindow(0);
        hook.setAltitudeWindow(60);
        assertEq(hook.altitudeWindow(), 60);
        // shorter window → a held move breaks sooner
        _buildHistory();
        uint8 tier0 = hook.altitudeTierOf(pid);
        _next(1);
        _buy(whale, 3_000_000 ether);
        _next(61);
        _buy(alice, 1 ether);
        _next(1);
        _buy(alice, 1 ether);
        assertGt(hook.altitudeTierOf(pid), tier0);

        vm.prank(alice);
        vm.expectRevert(Launchpad.OnlyOwner.selector);
        launchpad.setAltitudeWindow(60);
        vm.prank(owner);
        launchpad.setAltitudeWindow(120);
        assertEq(launchpad.altitudeWindow(), 120);
    }

    // ───────────── Altitude on TWAP (curve phase) ─────────────

    function _curveBuyUntil(BondingCurve c, uint256 mcap) internal {
        for (uint256 i; i < 400 && c.mcapNow() < mcap; i++) {
            _buy(c, trader1, 50 ether, 0);
        }
        require(c.mcapNow() >= mcap, "curve not pumped");
    }

    function test_altitude_curve_spike_vs_sustained() public {
        (BondingCurve c, Token t) = _launch(0, 0);
        _warpPastSnipe();
        vm.roll(block.number + 1);
        _buy(c, trader2, 1 ether, 0);
        _next(600);
        assertEq(c.altitudeTier(), 0);

        // spike + dump in one block → spot crosses $12K, TWAP doesn't
        vm.recordLogs();
        uint256 before = t.balanceOf(trader1);
        _curveBuyUntil(c, 13_000 ether);
        assertGe(Altitude.tierOf(c.mcapNow()), 1);
        _sell(c, t, trader1, t.balanceOf(trader1) - before, 0);
        (uint256 n,) = _countTierBreaks(vm.getRecordedLogs(), address(c));
        assertEq(n, 0, "curve spike caused TierBreak");
        assertEq(c.altitudeTier(), 0);

        // sustained: pump and hold past the window
        _next(1);
        _curveBuyUntil(c, 13_000 ether);
        vm.recordLogs();
        for (uint256 i; i < 7; i++) {
            _next(60);
            _buy(c, trader2, 1 ether, 0);
        }
        uint8 lastTo;
        (n, lastTo) = _countTierBreaks(vm.getRecordedLogs(), address(c));
        assertEq(n, 1);
        assertEq(lastTo, 1);
        (uint256 twap, uint32 w) = c.twapMcapUsd(c.altitudeWindow());
        assertEq(w, 300);
        assertGe(twap, 12_000 ether);
    }

    function test_marketlens_twap_resists_spike() public {
        MarketLens lens = new MarketLens(address(launchpad), address(migration));
        _buildHistory();
        _next(5);
        (uint256 m0, uint32 w0) = lens.twapMcapUsd(address(tok), 300);
        (uint256 h0,) = hook.twapMcapUsd(pid, 300);
        assertEq(m0, h0);
        assertEq(w0, 300);
        uint256 spot0 = lens.mcapNow(address(tok));
        _buy(whale, 3_000_000 ether);
        assertGt(lens.mcapNow(address(tok)), spot0 * 10, "spot spiked");
        (uint256 m1,) = lens.twapMcapUsd(address(tok), 300);
        assertEq(m1, m0, "lens TWAP moved in-block");
        // pre-grad coin: curve TWAP path
        (BondingCurve c,) = _launch(0, 0);
        (, uint32 wc) = lens.twapMcapUsd(c.token(), 300);
        assertEq(wc, 0);
    }

    function test_altitude_tier_ladder() public pure {
        assertEq(Altitude.tierOf(0), 0);
        assertEq(Altitude.tierOf(11_999 ether), 0);
        assertEq(Altitude.tierOf(12_000 ether), 1);
        assertEq(Altitude.tierOf(33_000 ether), 4);
        assertEq(Altitude.tierOf(100_000 ether), 6);
        assertEq(Altitude.tierOf(3_300_000_000 ether), 17);
        assertEq(Altitude.tierOf(1e40), 17);
    }

    function testFuzz_twap_never_moves_within_a_block(uint96 amt, bool buyFirst) public {
        _buildHistory();
        _next(17);
        (int24 b,) = hook.twapTick(pid, 300);
        uint256 a = bound(uint256(amt), 1 ether, 3_000_000 ether);
        if (buyFirst) _buy(whale, a);
        else _sell(whale, a * 100);
        _buy(jit, a / 2 + 1);
        (int24 x,) = hook.twapTick(pid, 300);
        assertEq(x, b);
    }
}

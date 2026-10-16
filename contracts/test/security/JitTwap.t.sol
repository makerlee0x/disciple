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
import {ITradeEvents} from "../../src/interfaces/ITradeEvents.sol";
import {IAltitudeEvents} from "../../src/interfaces/IAltitudeEvents.sol";
import {Altitude} from "../../src/libraries/Altitude.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice SEC-02 (JIT hold + LP gate), SEC-03 (QuotePricer TWAP), limit-order auto-close, altitude on spot.
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

    function test_twm_params_owner_only_and_bounded() public {
        vm.prank(alice);
        vm.expectRevert(TrampWallManager.OnlyOwner.selector);
        twm.setMinHold(1);
        vm.expectRevert(TrampWallManager.BadParam.selector);
        twm.setMinHold(8 days);
        twm.setMinHold(600);
        assertEq(twm.minHoldSeconds(), 600);
        vm.prank(alice);
        vm.expectRevert(TrampWallManager.OnlyOwner.selector);
        twm.setKeeperTipBps(5);
        vm.expectRevert(TrampWallManager.BadParam.selector);
        twm.setKeeperTipBps(101);
        twm.setKeeperTipBps(100);
        assertEq(twm.keeperTipBps(), 100);
        vm.prank(alice);
        vm.expectRevert(DiscipleHook.OnlyAdmin.selector);
        hook.setLiquidityManager(alice, true);
    }

    // ───────────── SEC-03: TWAP manipulation ─────────────

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

    // ───────────── Altitude on TWAP (curve phase) ─────────────

    // ───────────── limit-order auto-close (keeper tip) ─────────────

    /// @dev one-sided range: c0-only sits above the pool tick, c1-only below.
    function _sideRange(bool c0Side, int24 w) internal view returns (int24 lo, int24 hi) {
        (int24 tick,, int24 ts,) = twm.poolState(address(tok));
        int24 a = _floor(tick, ts);
        if (c0Side) {
            lo = a + ts;
            hi = lo + ts * w;
        } else {
            hi = a;
            lo = hi - ts * w;
        }
    }

    function _placeAndFillWall() internal returns (uint256 id) {
        (int24 lo, int24 hi) = _sideRange(_tIs0(), 4); // wall = token side, above price
        vm.prank(alice);
        (id,) = twm.placeWall(address(tok), lo, hi, 5_000_000 ether, 0, block.timestamp + 1);
        for (uint256 i; i < 200 && !twm.isFilled(id); i++) {
            _buy(whale, 20_000 ether);
        }
        require(twm.isFilled(id), "wall not filled");
    }

    function test_pull_filled_wall_pays_owner_minus_keeper_tip() public {
        uint256 id = _placeAndFillWall();
        address keeper = makeAddr("keeper");
        vm.expectRevert(abi.encodeWithSelector(TrampWallManager.HoldActive.selector, block.timestamp + 300));
        vm.prank(keeper);
        twm.pull(id);
        _next(300);
        (uint256 fq,) = twm.pendingFees(id);
        uint256 q0 = quote.balanceOf(alice);
        uint256 t0 = tok.balanceOf(alice);
        vm.recordLogs();
        vm.prank(keeper);
        (uint256 qOut, uint256 tOut) = twm.pull(id);
        assertEq(quote.balanceOf(alice) - q0, qOut);
        assertEq(tok.balanceOf(alice) - t0, tOut);
        assertGt(qOut, 0, "wall sold into quote");
        uint256 kq = quote.balanceOf(keeper);
        uint256 kt = tok.balanceOf(keeper);
        // tip = 0.1% of the whole payout (proceeds + fees)
        assertApproxEqAbs(kq, (qOut + kq) * 10 / 10_000, 1);
        assertApproxEqAbs(kt, (tOut + kt) * 10 / 10_000, 1);
        assertGt(kq, 0);
        assertGe(qOut + kq + 1, fq);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool tipEv;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == TrampWallManager.KeeperTipPaid.selector) tipEv = true;
        }
        assertTrue(tipEv);
        vm.expectRevert(TrampWallManager.Inactive.selector);
        twm.pull(id);
    }

    function test_pull_filled_tramp_floor_pays_owner_tokens() public {
        (int24 lo, int24 hi) = _sideRange(!_tIs0(), 4); // tramp = quote side, below price
        vm.prank(alice);
        (uint256 id,) = twm.placeTramp(address(tok), lo, hi, 2_000 ether, 0, block.timestamp + 1);
        for (uint256 i; i < 200 && !twm.isFilled(id); i++) {
            _sell(whale, 5_000_000 ether);
        }
        assertTrue(twm.isFilled(id), "tramp not filled");
        _next(300);
        uint256 t0 = tok.balanceOf(alice);
        address keeper = makeAddr("keeperT");
        vm.prank(keeper);
        (, uint256 tOut) = twm.pull(id);
        assertGt(tOut, 0, "floor bought tokens");
        assertEq(tok.balanceOf(alice) - t0, tOut);
        assertApproxEqAbs(tok.balanceOf(keeper), (tOut + tok.balanceOf(keeper)) * 10 / 10_000, 1);
    }

    function test_pull_zero_tip_and_unfilled_reverts() public {
        twm.setKeeperTipBps(0);
        (int24 lo, int24 hi) = _sideRange(!_tIs0(), 4); // tramp below price
        vm.prank(alice);
        (uint256 tid,) = twm.placeTramp(address(tok), lo, hi, 1_000 ether, 0, block.timestamp + 1);
        _next(300);
        vm.expectRevert(TrampWallManager.NotFilled.selector);
        twm.pull(tid);
        uint256 id = _placeAndFillWall();
        _next(300);
        address keeper = makeAddr("keeper0");
        vm.prank(keeper);
        twm.pull(id);
        assertEq(quote.balanceOf(keeper) + tok.balanceOf(keeper), 0);
    }

    function test_cancel_pays_all_fees_no_forfeit() public {
        uint256 id = _jitAroundSells(alice);
        (uint256 pq, uint256 pt) = twm.pendingFees(id);
        _next(300);
        uint256 tq0 = quote.balanceOf(treasury);
        vm.recordLogs();
        vm.prank(alice);
        twm.cancel(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == TrampWallManager.Cancelled.selector) {
                (,,,, uint256 qf, uint256 tf) =
                    abi.decode(logs[i].data, (int24, int24, uint256, uint256, uint256, uint256));
                assertEq(qf, pq);
                assertEq(tf, pt);
                seen = true;
            }
        }
        assertTrue(seen);
        assertEq(quote.balanceOf(treasury), tq0, "no forfeit");
    }

    // ───────────── Altitude = SPOT ─────────────

    function test_altitude_hook_tier_follows_spot_each_trade() public {
        uint8 tier0 = hook.altitudeTierOf(pid);
        vm.recordLogs();
        _buy(whale, 20_000 ether);
        uint8 up = Altitude.tierOf(_mcapSpot());
        assertGt(up, tier0);
        (uint256 n, uint8 lastTo) = _countTierBreaks(vm.getRecordedLogs(), address(hook));
        assertEq(n, 1, "break on the same trade");
        assertEq(lastTo, up);
        assertEq(hook.altitudeTierOf(pid), up);
        vm.recordLogs();
        _sell(whale, tok.balanceOf(whale) / 2);
        uint8 down = Altitude.tierOf(_mcapSpot());
        (n, lastTo) = _countTierBreaks(vm.getRecordedLogs(), address(hook));
        assertLt(down, up);
        assertEq(n, 1);
        assertEq(lastTo, down);
        assertEq(hook.altitudeTierOf(pid), down);
    }

    function test_altitude_update_equals_trade_mcap() public {
        vm.recordLogs();
        _buy(alice, 100 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 tradeMcap;
        uint256 altMcap;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics[0] == IAltitudeEvents.AltitudeUpdate.selector) {
                (altMcap,) = abi.decode(logs[i].data, (uint256, uint8));
            }
            if (logs[i].topics[0] == ITradeEvents.Trade.selector) {
                (,,,,,,,, uint256 m) = abi.decode(
                    logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
                );
                tradeMcap = m;
            }
        }
        assertGt(altMcap, 0);
        assertEq(altMcap, tradeMcap);
    }

    function test_altitude_curve_spot_break() public {
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        vm.recordLogs();
        for (uint256 i; i < 400 && c.mcapNow() < 13_000 ether; i++) {
            _buy(c, trader1, 50 ether, 0);
        }
        (uint256 n, uint8 lastTo) = _countTierBreaks(vm.getRecordedLogs(), address(c));
        assertEq(n, 1);
        assertEq(lastTo, 1);
        assertEq(c.altitudeTier(), 1);
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
}

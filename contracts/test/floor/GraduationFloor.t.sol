// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FloorBands} from "../../src/libraries/FloorBands.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Phase 3a graduation floor: 16 USDG-only locked bands seeded in the graduation tx.
contract GraduationFloorTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;

    bytes32 constant FLOOR_SEEDED = keccak256("FloorSeeded(address,bytes32,int24,uint8,uint256,uint256)");
    bytes32 constant MIGRATED = keccak256("Migrated(address,address,bytes32,uint256,uint256,uint160)");

    struct Grad {
        BondingCurve c;
        Token tok;
        bool c0;
        uint256 snipe; // sniper escrow at graduation
        uint256 migratedQuote; // quote the curve sent to Migration (reserve + sniper escrow)
        uint256 seeded;
        uint256 dust;
        int24 base;
    }

    /// @dev Launch until the token sorts as wanted, optionally snipe (escrow > 0), graduate, decode the events.
    function _grad(bool wantC0, uint256 snipeQuote) internal returns (Grad memory g) {
        for (uint256 i; i < 24; ++i) {
            (g.c, g.tok) = _launch(0, 0);
            if ((uint160(address(g.tok)) < uint160(address(quote))) == wantC0) break;
        }
        g.c0 = uint160(address(g.tok)) < uint160(address(quote));
        require(g.c0 == wantC0, "order");
        if (snipeQuote > 0) _buy(g.c, sniper, snipeQuote, 0);
        g.snipe = g.c.snipeEscrow();
        vm.recordLogs();
        _graduate(g.c);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == FLOOR_SEEDED && address(uint160(uint256(logs[i].topics[1]))) == address(g.tok)) {
                (, int24 b, uint8 n, uint256 s, uint256 d) = abi.decode(logs[i].data, (bytes32, int24, uint8, uint256, uint256));
                assertEq(n, 16);
                (g.base, g.seeded, g.dust) = (b, s, d);
            }
            if (logs[i].topics[0] == MIGRATED && address(uint160(uint256(logs[i].topics[1]))) == address(g.tok)) {
                (,, uint256 q,) = abi.decode(logs[i].data, (bytes32, uint256, uint256, uint160));
                g.migratedQuote = q;
            }
        }
        require(g.seeded > 0, "no FloorSeeded");
    }

    function _spotTick(Token tok) internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, _poolKey(tok).toId());
    }

    function _sumQuote(LockedLP.FloorBand[] memory b) internal pure returns (uint256 s) {
        for (uint256 i; i < b.length; ++i) s += b[i].quoteAmount;
    }

    // ── seeding: sums, budget, escrow exclusion ──────────────────────────────

    function _checkSeed(bool c0) internal {
        Grad memory g = _grad(c0, 50 ether); // a sniper buy inside the 7 s window → snipeEscrow > 0
        assertGt(g.snipe, 0, "sniper escrow present");
        (,,, uint256 pairing,,,) = lockedLP.positions(address(g.tok)); // main position's quote
        // floor budget = curve reserve − full-range pairing (sniper escrow excluded)
        uint256 reserve = g.migratedQuote - g.snipe;
        assertEq(g.seeded + g.dust, reserve - pairing, "bands + dust == curve leftover");
        assertLt(g.dust, 1e9, "rounding dust only");
        // ~$1,201 on the 18-dec mock USDG at $1 (raise $6,454.55 net − pairing $5,253.28)
        assertApproxEqAbs(g.seeded, 1201.27 ether, 1 ether, "~$1,201 floor");
        (int24 base, uint8 n, uint128 seeded) = lockedLP.floorInfo(address(g.tok));
        assertEq(base, g.base);
        assertEq(n, 16);
        assertEq(seeded, g.seeded);
        // the excluded escrows + dust sit in the compound bucket; LockedLP holds exactly the bucket
        (, uint256 bq) = lockedLP.compoundBucket(address(g.tok));
        assertGe(bq, g.snipe + g.dust, "sniper escrow + dust in bucket");
        assertEq(quote.balanceOf(address(lockedLP)), bq, "quote held == bucket");
        LockedLP.FloorBand[] memory b = lockedLP.floorBands(address(g.tok));
        assertEq(b.length, 16);
        assertApproxEqAbs(_sumQuote(b), g.seeded, 64, "bands hold the seed");
        console2.log(c0 ? "token=currency0" : "token=currency1", "seeded / dust", g.seeded, g.dust);
    }

    function test_seed_sums_to_leftover_tokenC0() public {
        _checkSeed(true);
    }

    function test_seed_sums_to_leftover_tokenC1() public {
        _checkSeed(false);
    }

    // ── geometry: aligned, USDG-only, shape ──────────────────────────────────

    function _checkGeometry(bool c0) internal {
        Grad memory g = _grad(c0, 0);
        int24 cur = _spotTick(g.tok);
        LockedLP.FloorBand[] memory b = lockedLP.floorBands(address(g.tok));
        for (uint256 i; i < 16; ++i) {
            assertEq(b[i].tickLower % 60, 0, "aligned lo");
            assertEq(b[i].tickUpper % 60, 0, "aligned hi");
            assertEq(b[i].tokenAmount, 0, "USDG only");
            if (c0) assertLe(b[i].tickUpper, cur, "below spot");
            else assertGt(b[i].tickLower, cur, "above spot");
            (,, uint256 bps) = FloorBands.band(i);
            assertApproxEqRel(b[i].quoteAmount, g.seeded * bps / 10_000, 1e12, "share");
            // log: band, ticks, mcap range ($, 18-dec mock USDG at $1), USDG
            _logBand(i, b[i], c0);
        }
        // layer A: 30% flat down to 0.75x; layer B 70% down to ~0.1x, bottom = 4x top
        int24 flatEdge = c0 ? b[3].tickLower : b[3].tickUpper;
        int24 botEdge = c0 ? b[15].tickLower : b[15].tickUpper;
        assertEq(flatEdge, c0 ? g.base - 2880 : g.base + 2880);
        assertEq(botEdge, c0 ? g.base - 23040 : g.base + 23040);
        assertApproxEqRel(b[15].quoteAmount * 1e18 / b[4].quoteAmount, 4e18, 0.01e18, "4x bottom-heavy");
        uint256 flat;
        for (uint256 i; i < 4; ++i) flat += b[i].quoteAmount;
        assertApproxEqRel(flat, g.seeded * 3 / 10, 1e12, "30% flat");
    }

    function _mcap(int24 t, bool c0) internal pure returns (uint256) {
        // price (quote wei per token wei) = 1.0001^t (c0) or 1.0001^-t (c1); mcap = price * 1e24 supply, 18-dec quote
        uint256 sp = TickMath.getSqrtPriceAtTick(t);
        uint256 p = sp * sp >> 96; // price * 2^96
        if (!c0) p = (uint256(1) << 192) / p;
        return p * 1e6 >> 96; // USD (supply 1e24 / quote 1e18 = 1e6)
    }

    function _logBand(uint256 i, LockedLP.FloorBand memory b, bool c0) internal pure {
        (uint256 lo, uint256 hi) = c0 ? (_mcap(b.tickLower, true), _mcap(b.tickUpper, true)) : (_mcap(b.tickUpper, false), _mcap(b.tickLower, false));
        console2.log(string.concat("band ", vm.toString(i), " ticks ", vm.toString(b.tickLower), "..", vm.toString(b.tickUpper)));
        console2.log(string.concat("   mcap $", vm.toString(lo), "-$", vm.toString(hi), " USDG(wei) ", vm.toString(b.quoteAmount)));
    }

    function test_geometry_tokenC0() public {
        _checkGeometry(true);
    }

    function test_geometry_tokenC1() public {
        _checkGeometry(false);
    }

    // ── sells drain, buys re-arm ─────────────────────────────────────────────

    function _dumpAll(Token tok, uint256 maxWallets) internal {
        for (uint256 i; i < maxWallets; ++i) {
            address w = makeAddr(string(abi.encodePacked("gradW", vm.toString(i), address(quote))));
            uint256 bal = tok.balanceOf(w);
            if (bal == 0) continue;
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 12);
            _swapExactInTokenForQuote(tok, w, bal);
        }
    }

    function _drainRearm(bool c0) internal {
        Grad memory g = _grad(c0, 0);
        LockedLP.FloorBand[] memory b0 = lockedLP.floorBands(address(g.tok));
        _dumpAll(g.tok, 80);
        LockedLP.FloorBand[] memory b1 = lockedLP.floorBands(address(g.tok));
        assertLt(_sumQuote(b1), _sumQuote(b0), "sells drain the floor");
        assertLt(b1[0].quoteAmount, b0[0].quoteAmount / 100, "top flat band spent");
        assertGt(b1[0].tokenAmount, 0, "top band bought tokens");
        console2.log("floor USDG after dump", _sumQuote(b1), "of", _sumQuote(b0));
        for (uint256 i; i < 16; ++i) assertEq(b1[i].liquidity, b0[i].liquidity, "liquidity unchanged");
        // buy back above graduation: every band re-arms to USDG
        int24 start = g.c0 ? g.base : g.base - 60;
        for (uint256 k; k < 400; ++k) {
            int24 t = _spotTick(g.tok);
            if (g.c0 ? t >= start : t < start) break;
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 12);
            _swapExactInQuoteForToken(g.tok, trader1, 250 ether);
        }
        LockedLP.FloorBand[] memory b2 = lockedLP.floorBands(address(g.tok));
        for (uint256 i; i < 16; ++i) {
            assertEq(b2[i].tokenAmount, 0, "re-armed: USDG only");
            assertApproxEqRel(b2[i].quoteAmount, b0[i].quoteAmount, 1e9, "re-armed: same USDG");
        }
    }

    function test_drain_and_rearm_tokenC0() public {
        _drainRearm(true);
    }

    function test_drain_and_rearm_tokenC1() public {
        _drainRearm(false);
    }

    // ── compounding never touches the floor ──────────────────────────────────

    function test_compound_never_touches_floor() public {
        Grad memory g = _grad(false, 0);
        _refReady(g.tok);
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 0, 5000);
        LockedLP.FloorBand[] memory b0 = lockedLP.floorBands(address(g.tok));
        (,,,,,, uint128 l0) = lockedLP.positions(address(g.tok));
        bytes32 COMPOUNDED = keccak256("LiquidityCompounded(address,uint128,uint256,uint256,uint256,uint256)");
        vm.recordLogs();
        for (uint256 i; i < 6; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 61);
            _swapExactInQuoteForToken(g.tok, trader1, 20 ether);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) if (logs[i].topics[0] == COMPOUNDED) n++;
        assertGt(n, 0, "compounded");
        (,,,,,, uint128 l1) = lockedLP.positions(address(g.tok));
        assertGt(l1, l0, "main position grew");
        LockedLP.FloorBand[] memory b1 = lockedLP.floorBands(address(g.tok));
        for (uint256 i; i < 16; ++i) assertEq(b1[i].liquidity, b0[i].liquidity, "floor liquidity untouched");
        (int24 tl, int24 tu, bytes32 salt) = lockedLP.positionTicks(address(g.tok));
        assertEq(tl, TickMath.minUsableTick(60));
        assertEq(tu, TickMath.maxUsableTick(60));
        for (uint256 i; i < 16; ++i) assertTrue(salt != FloorBands.salt(address(g.tok), i), "distinct salts");
    }

    // ── nothing removes liquidity ────────────────────────────────────────────

    function test_nothing_removes_floor() public {
        Grad memory g = _grad(true, 0);
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(g.tok), 1);
        PoolKey memory key = _poolKey(g.tok);
        PoolModifyLiquidityTest r = new PoolModifyLiquidityTest(manager);
        LockedLP.FloorBand[] memory b = lockedLP.floorBands(address(g.tok));
        for (uint256 i; i < 16; i += 5) {
            // a third party with the same ticks + salt is a different owner → v4 reverts (no liquidity of its own)
            vm.expectRevert();
            r.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: b[i].tickLower,
                    tickUpper: b[i].tickUpper,
                    liquidityDelta: -int256(uint256(b[i].liquidity)),
                    salt: FloorBands.salt(address(g.tok), i)
                }),
                ""
            );
        }
        // LockedLP itself has no remove path: only PoolManager may call its unlock callback
        vm.expectRevert(LockedLP.OnlyPoolManager.selector);
        lockedLP.unlockCallback(abi.encode(uint8(0), bytes("")));
        LockedLP.FloorBand[] memory b2 = lockedLP.floorBands(address(g.tok));
        for (uint256 i; i < 16; ++i) assertEq(b2[i].liquidity, b[i].liquidity);
    }

    // ── fuzz: band geometry for any spot tick and both orders ───────────────

    function testFuzz_bandGeometry(int24 cur, bool c0) public pure {
        cur = int24(bound(int256(cur), -800_000, 800_000));
        int24 base = FloorBands.baseTick(cur, c0);
        assertEq(base % 60, 0);
        if (c0) assertLe(base, cur);
        else assertGt(base, cur);
        assertLe(c0 ? cur - base : base - cur, 60);
        uint256 bps;
        for (uint256 i; i < Constants.MAX_FLOOR_BANDS; ++i) {
            (uint256 lo, uint256 hi, uint256 w) = FloorBands.band(i);
            assertLt(lo, hi);
            bps += w;
            (int24 tl, int24 tu) = FloorBands.ticks(base, c0, i);
            assertEq(tl % 60, 0);
            assertEq(tu % 60, 0);
            assertLt(tl, tu);
            if (c0) assertLe(tu, cur);
            else assertGt(tl, cur);
            for (uint256 j; j < i; ++j) assertTrue(FloorBands.salt(address(1), i) != FloorBands.salt(address(1), j));
        }
        assertEq(bps, 10_000, "weights sum to 100%");
    }
}

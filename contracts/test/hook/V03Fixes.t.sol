// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest, Keeper} from "./Disciple.t.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {DiscipleBooks as BK} from "../../src/hook/DiscipleBooks.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice Disciple v0.3 bug fixes ported from Carry v0.3 (rounds 6 and 7) plus the cross-chain anchor cap
///         (disciple #356 review). The N-1, M-01, push and clamp tests fail on the v0.2 hook (follower @ 38e094c). Inherits DiscipleTest for
///         its helpers (its own tests run here too).
contract V03FixesTest is DiscipleTest {
    using PoolIdLibrary for PoolKey;

    /// @dev book.dy (int128, high half of Pool slot +25; book.dx is the low half). Layout unchanged from v0.2.
    function _bookDy(PoolId id) internal view returns (int256) {
        bytes32 base = keccak256(abi.encode(PoolId.unwrap(id), uint256(1)));
        uint256 w = uint256(vm.load(address(hook), bytes32(uint256(base) + 25)));
        return int256(int128(uint128(w >> 128)));
    }

    function _bookDx(PoolId id) internal view returns (int256) {
        bytes32 base = keccak256(abi.encode(PoolId.unwrap(id), uint256(1)));
        uint256 w = uint256(vm.load(address(hook), bytes32(uint256(base) + 25)));
        return int256(int128(uint128(w)));
    }

    function _abs(int128 v) internal pure returns (uint256) {
        return uint256(int256(v < 0 ? -v : v));
    }

    /// @dev (coin out, quote in) of a buy, from the swapper's delta
    function _buy(PoolKey memory key, uint256 quoteIn) internal returns (uint256 coinOut, uint256 paid) {
        BalanceDelta d = _swap(key, true, -int256(quoteIn));
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        (int128 c, int128 q) = coinIs0 ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        coinOut = _abs(c);
        paid = _abs(q);
    }

    // ---------------------------------------------------------------------------------------------
    // N-1: same-chain swaps book earnings at the less favourable of the anchor and the leader
    // ---------------------------------------------------------------------------------------------

    /// The leader moves +0.9% and the anchor (a block behind) still sits at the old price. A buy fills at the live
    /// leader's ask. v0.2 marked it at the anchor and booked the whole gap as fees (~13x the real margin in Carry's
    /// PoC). v0.3 marks it at the leader, so the booked earnings are at most the real margin at the leader's price.
    function test_v03_N1_leaderMoveIsNotBookedAsFees() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _nextBlock();
        pair.set(1_000_000e18, 2_018_000e18); // +0.9%
        _nextBlock();
        uint256 a = hook.poolState(id).anchorX128;
        (uint256 coinOut, uint256 paid) = _buy(key, 2_000e18);
        assertEq(hook.poolState(id).anchorX128, a, "the anchor has not seen the move yet");
        uint256 leader = _px(2_018_000e18);
        assertGt(leader, a);
        assertEq(_bookDx(id), 0, "same chain books into dy only");
        int256 booked = _bookDy(id);
        // the real margin, coin valued at the live leader (what the pool could buy it back for, before the fee)
        int256 real = int256(paid) - int256(Math.mulDiv(coinOut, leader, Q128, Math.Rounding.Ceil));
        int256 atAnchor = int256(paid) - int256(Math.mulDiv(coinOut, a, Q128, Math.Rounding.Ceil));
        assertLe(booked, real, "never more than the real margin");
        assertEq(booked, real, "marked at the leader exactly (sample = spot here)");
        assertGt(atAnchor, 3 * real, "v0.2's mark would have booked the lag as fees");
    }

    /// The mirror case: the leader drops and a sell fills at the live bid. Booked at the leader, not the anchor.
    function test_v03_N1_leaderDropSellMarkedLow() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _nextBlock();
        pair.set(1_000_000e18, 1_982_000e18); // -0.9%
        _nextBlock();
        uint256 a = hook.poolState(id).anchorX128;
        BalanceDelta d = _swap(key, false, -int256(1_000e18));
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        (int128 c, int128 q) = coinIs0 ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 coinIn = _abs(c);
        uint256 got = _abs(q);
        uint256 leader = _px(1_982_000e18);
        assertLt(leader, a);
        int256 real = int256(Math.mulDiv(coinIn, leader, Q128)) - int256(got);
        assertEq(_bookDy(id), real, "the pool buys coin: valued at the lower leader");
    }

    /// A leader pushed for this block's sample alone and put back books nothing made up: the mark uses the leader
    /// only as far as both the block's sample and the live spot agree.
    function test_v03_N1_pushedSampleAloneMovesNoMark() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        uint256 snap = vm.snapshotState();
        _nextBlock();
        _buy(key, 2_000e18);
        int256 honest = _bookDy(id);
        vm.revertToState(snap);
        _nextBlock();
        pair.set(1_000_000e18, 2_200_000e18); // pushed +10% for the first touch only
        hook.sample(id);
        pair.set(1_000_000e18, 2_000_000e18); // put back
        _buy(key, 2_000e18);
        assertEq(_bookDy(id), honest, "a pushed sample alone does not change the booked earnings");
    }

    // ---------------------------------------------------------------------------------------------
    // M-01: a capital move settles at the stored anchor, which a same-transaction push cannot move
    // ---------------------------------------------------------------------------------------------

    /// One transaction: push the leader, sample (this block's sample is now the pushed price), put it back, trade,
    /// then deposit. v0.2 settled the open trades at `_stepped` (one step toward the pushed sample, 1% off), so the
    /// first toucher could value the interval up to minStep off. v0.3 settles at the stored anchor: the lots end up
    /// exactly as if nobody had pushed.
    function test_v03_M01_sameTxPushDoesNotMoveTheCapitalSettle() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        // a second lot, so a mis-mark would move value between lots
        vm.prank(lp);
        hook.deposit(id, 100_000e18, 200_000e18);
        uint256 snap = vm.snapshotState();

        _nextBlock();
        hook.sample(id); // honest first touch
        _buy(key, 20_000e18);
        _swap(key, false, -int256(2_000e18));
        vm.prank(lp);
        hook.deposit(id, 1_000e18, 2_000e18);
        (, uint256 b1, uint256 x1, uint256 y1) = _lot(id, 1);
        (, uint256 b2, uint256 x2, uint256 y2) = _lot(id, 2);

        vm.revertToState(snap);
        _nextBlock();
        pair.set(1_000_000e18, 2_200_000e18);
        hook.sample(id); // first touch records the pushed price
        pair.set(1_000_000e18, 2_000_000e18);
        _buy(key, 20_000e18);
        _swap(key, false, -int256(2_000e18));
        vm.prank(lp);
        hook.deposit(id, 1_000e18, 2_000e18);
        (, uint256 c1, uint256 cx1, uint256 cy1) = _lot(id, 1);
        (, uint256 c2, uint256 cx2, uint256 cy2) = _lot(id, 2);

        assertGt(b1 + x1 + y1, 0, "the trades did pay lot 1");
        assertEq(c1, b1, "lot 1 compounded");
        assertEq(c2, b2, "lot 2 compounded");
        assertEq(cx1 + cy1, x1 + y1, "lot 1 claims");
        assertEq(cx2 + cy2, x2 + y2, "lot 2 claims");
    }

    function _lot(PoolId id, uint256 lot) internal returns (uint256 s, uint256 b, uint256 cx, uint256 cy) {
        (, s, b, cx, cy) = hook.lotState(id, lot);
    }

    // ---------------------------------------------------------------------------------------------
    // Cross chain: a pushed price moves the anchor by at most one step (minStep, 1% in these tests)
    // ---------------------------------------------------------------------------------------------

    /// A flash-moved home pool (+50%) pushed over LayerZero moves the anchor and the settle mark by one step only.
    function test_v03_pushedFlashPriceStepsTheAnchorOnce() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        uint256 a0 = hook.poolState(id).anchorX128;
        assertEq(a0, Q128 * 2, "the first price sets the anchor outright");
        _swap(key, true, -int256(10e18));
        pair.set(1_000_000e18, 3_000_000e18); // flash-moved +50% for the sender's read
        _lzPush(id, address(0xBAD), 30, HOME_EID);
        assertEq(hook.poolState(id).anchorX128, Math.mulDiv(a0, 1_010_000, 1_000_000), "one 1% step, not 50%");
    }

    /// An honest 5% move is caught up over a few pushes, one step each, and every catch-up push is still paid.
    function test_v03_pushCatchUpInStepsAndPaid() public {
        (, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        pair.set(1_000_000e18, 2_100_000e18); // +5%
        vm.fee(5 gwei);
        uint256 a = hook.poolState(id).anchorX128;
        for (uint256 i = 0; i < 4; i++) {
            Keeper k = new Keeper();
            _lzPush(id, address(k), 30, HOME_EID);
            uint256 n = hook.poolState(id).anchorX128;
            assertEq(n, Math.mulDiv(a, 1_010_000, 1_000_000), "one step per push");
            assertGt(hook.owed(address(k), address(usd)), 0, "a catch-up push is paid (home price still >= 1% away)");
            a = n;
        }
        _lzPush(id, address(0xC0FFEE), 30, HOME_EID);
        assertEq(hook.poolState(id).anchorX128, Q128 * 21 / 10, "caught up");
    }

    /// Recovery from local mode is stepped too (a recovery push is the same permissionless read).
    function test_v03_recoveryPushIsStepped() public {
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 40, HOME_EID);
        vm.warp(block.timestamp + 2 hours + 1);
        _swap(key, true, -int256(5e18));
        assertTrue(hook.poolState(id).local);
        pair.set(1_000_000e18, 4_000_000e18); // +100%
        _lzPush(id, address(0xC0FFEE), 3 minutes, HOME_EID);
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertFalse(v.local, "recovered");
        assertEq(v.anchorX128, Q128 * 202 / 100, "one step from the frozen anchor");
    }

    // ---------------------------------------------------------------------------------------------
    // Library fixes: edge clamp at the leader's bid / ask, v4 protocol fee in the leader fee
    // ---------------------------------------------------------------------------------------------

    /// With a 0-fee leader the 1bp edge would put the buy floor below the leader's bid (a free round trip). The
    /// clamp keeps both bounds outside the leader's own quotes for any leader fee.
    function test_v03_edgeClampAtLeaderQuotes() public pure {
        uint256 spot = Q128 * 2;
        for (uint24 f = 0; f <= 30; f += 5) {
            (,, uint256 pb, uint256 ps) = BK.sameQuote(spot, spot, 3000, spot, f);
            uint256 srcAsk = Math.mulDiv(spot, 1e6, 1e6 - f, Math.Rounding.Ceil);
            uint256 srcBid = Math.mulDiv(spot, 1e6 - f, 1e6);
            assertGe(pb, srcBid, "buy floor never under the leader's bid");
            assertLe(ps, srcAsk, "sell ceiling never over the leader's ask");
        }
        // a normal 0.3% leader: unchanged (ask * 0.9999 > bid)
        (,, uint256 pb3, uint256 ps3) = BK.sameQuote(spot, spot, 3000, spot, 3000);
        assertEq(
            pb3, Math.mulDiv(Math.mulDiv(spot, 1e6, 997_000, Math.Rounding.Ceil), 9999, 10_000, Math.Rounding.Ceil)
        );
        assertEq(ps3, Math.mulDiv(Math.mulDiv(spot, 997_000, 1e6), 10_001, 10_000));
    }

    /// A v4 leader's fee now includes the smaller directional Uniswap protocol fee, compounded with the LP fee.
    function test_v03_v4LeaderFeeIncludesProtocolFee() public {
        bool coinIs0 = address(coin) < address(usd);
        PoolKey memory src = PoolKey({
            currency0: Currency.wrap(coinIs0 ? address(coin) : address(usd)),
            currency1: Currency.wrap(coinIs0 ? address(usd) : address(coin)),
            fee: 2500,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(src, TickMath.getSqrtPriceAtTick(coinIs0 ? int24(6900) : int24(-6900)));
        (, uint24 f0) = BK.leg(manager, 3, address(manager), PoolId.unwrap(src.toId()), coinIs0);
        assertEq(f0, 2500, "no protocol fee: the LP fee");
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(src, uint24(400) | (uint24(300) << 12)); // 0.04% one way, 0.03% the other
        (, uint24 f1) = BK.leg(manager, 3, address(manager), PoolId.unwrap(src.toId()), coinIs0);
        assertEq(f1, 2800, "smaller direction (300) + LP fee (2500), compounded: 300 * 2500 / 1e6 rounds to 0");
    }
}

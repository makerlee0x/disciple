// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {DiscipleBooks as BK} from "../../src/hook/DiscipleBooks.sol";
import {DiscipleSwapMath as SM} from "../../src/hook/libraries/DiscipleSwapMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {DisciplePushSender} from "../../src/hook/routes/DisciplePushSender.sol";
import {_noKey} from "./NoKey.sol";

/// @notice v0.3 step-1 fixes ported from the Carry v0.3 audit (rounds 6 and 7). Inherits DiscipleTest for its
///         helpers (its own tests run here too).
contract V03FixesTest is DiscipleTest {
    using PoolIdLibrary for PoolKey;

    /// @dev (coin, quote) deltas of a swap, from the swapper's side
    function _cq(PoolKey memory key, BalanceDelta d) internal view returns (int128 dc, int128 dq) {
        bool c0 = Currency.unwrap(key.currency0) == address(coin);
        (dc, dq) = c0 ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
    }

    function _step(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    /// @dev past the warm-up, with a few honest readings so the anchor sits on the leader
    function _ready(PoolId id) internal {
        _step(1 days);
        hook.withdraw(id, 1, 0, 0);
        for (uint256 i; i < 3; i++) {
            _step(12);
            hook.withdraw(id, 1, 0, 0);
        }
    }

    /// @dev everything one interval paid out of the reserves, valued at `m`: lot 1's claim, the creator's cut and
    ///      the jar skim (lot 1 is the creator's and the only LP)
    function _paid(PoolId id, uint256 jar0, uint256 m) internal returns (uint256) {
        (uint256 cx, uint256 cy) = hook.claim(id, 1);
        (uint256 kx, uint256 ky) = hook.claimCreator(id);
        DiscipleHook.PoolView memory v = hook.poolState(id);
        uint256 jar = v.jarY + Math.mulDiv(v.jarX, m, Q128);
        return cy + ky + Math.mulDiv(cx + kx, m, Q128) + jar - jar0;
    }

    function _jar(PoolId id, uint256 m) internal view returns (uint256) {
        DiscipleHook.PoolView memory v = hook.poolState(id);
        return v.jarY + Math.mulDiv(v.jarX, m, Q128);
    }

    /// N-1: the leader steps up 0.9% while the anchor still trails it. A buy fills at the live leader's bound; its
    /// earnings are booked against the leader (the higher mark for coin the pool pays out), not the stale anchor.
    function test_v03_fillMarkedAtLeaderWhenAnchorTrails() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        uint256 a0 = hook.poolState(id).anchorX128;
        pair.set(1_000_000e18, 2_018_000e18); // +0.9%
        uint256 lead = Math.mulDiv(2_018_000e18, Q128, 1_000_000e18);
        _step(12);
        uint256 jar0 = _jar(id, lead);
        BalanceDelta d = _swap(key, true, -int256(1000e18));
        assertEq(hook.poolState(id).anchorX128, a0, "anchor still trails the leader this block");
        (int128 dc, int128 dq) = _cq(key, d);
        uint256 q = uint256(int256(-dq));
        uint256 c = uint256(int256(dc));
        _step(12);
        hook.withdraw(id, 1, 0, 0); // settles the interval
        uint256 paid = _paid(id, jar0, lead);
        uint256 atLeader = q - Math.mulDiv(c, lead, Q128, Math.Rounding.Ceil);
        uint256 atAnchor = q - Math.mulDiv(c, a0, Q128, Math.Rounding.Ceil);
        assertGt(paid, 0);
        assertLe(paid, atLeader, "never more than the fill earned against the leader");
        assertApproxEqRel(paid, atLeader, 0.01e18, "pays what it earned against the leader");
        assertLt(paid * 3, atAnchor, "the stale anchor would have booked 3x+ more, out of principal");
    }

    /// N-1, the push-for-the-sample case: the leader is pushed down for this block's first-touch sample and put
    /// back. A sell the pool then buys is still marked at the honest price (it never counts the low sample alone).
    function test_v03_pushedSampleAloneDoesNotMoveTheMark() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        uint256 a0 = hook.poolState(id).anchorX128;
        _step(12);
        pair.set(1_000_000e18, 1_900_000e18); // pushed -5% for the sample
        hook.sample(id);
        pair.set(1_000_000e18, 2_000_000e18); // put back
        DiscipleHook.PoolView memory v0 = hook.poolState(id);
        BalanceDelta d = _swap(key, false, -int256(100e18)); // sell 100 coin
        (int128 dc, int128 dq) = _cq(key, d);
        uint256 c = uint256(int256(-dc));
        uint256 q = uint256(int256(dq));
        _step(12);
        pair.set(1_000_000e18, 2_000_000e18);
        hook.withdraw(id, 1, 0, 0);
        // the payout is split into tokens at the settle's mark (the anchor did take its one 1% step toward the
        // pushed sample, as v0.2 allows), so value what was paid at that mark
        uint256 a1 = hook.poolState(id).anchorX128;
        uint256 paid = _paid(id, v0.jarY + Math.mulDiv(v0.jarX, a1, Q128), a1);
        uint256 fair = Math.mulDiv(c, a0, Q128) - q;
        assertLe(paid, fair);
        assertApproxEqRel(paid, fair, 0.01e18, "marked at the honest price, not the pushed sample");
    }

    /// M-01: trades earlier in a block, then a capital move in the same block after the leader was pushed. The
    /// capital move settles at the stored anchor; the per-fill marks are unchanged by the push.
    function test_v03_capitalMoveAfterPushIsNotRevalued() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        uint256 a0 = hook.poolState(id).anchorX128;
        _step(12);
        uint256 jar0 = _jar(id, a0);
        _swap(key, true, -int256(500e18));
        _swap(key, false, -int256(200e18));
        pair.set(1_000_000e18, 2_200_000e18); // pushed +10% after this block's sample
        uint256 snap = vm.snapshotState();
        hook.withdraw(id, 1, 0, 0); // same block: settles at the stored anchor
        uint256 pushed = _paid(id, jar0, a0);
        vm.revertToState(snap);
        pair.set(1_000_000e18, 2_000_000e18);
        hook.withdraw(id, 1, 0, 0);
        uint256 honest = _paid(id, jar0, a0);
        assertGt(honest, 0);
        assertApproxEqRel(pushed, honest, 0.001e18, "a push after the sample does not move the payout");
    }

    /// N-2: on a leader with a fee under the edge the match bounds never sit inside the leader's own bid/ask.
    function test_v03_edgeClampAtLeaderBidAsk() public pure {
        uint256 spot = 2 * Q128;
        (,, uint256 pb, uint256 ps) = BK.sameQuote(spot, Q128, 3000, spot, 0);
        assertGe(pb, spot, "ask never below the zero-fee leader's ask");
        assertLe(ps, spot, "bid never above the zero-fee leader's bid");
        // a normal leader fee: the clamp changes nothing
        (,, pb, ps) = BK.sameQuote(spot, Q128, 3000, spot, 3000);
        uint256 srcAsk = Math.mulDiv(spot, 1e6, 1e6 - 3000, Math.Rounding.Ceil);
        uint256 srcBid = Math.mulDiv(spot, 1e6 - 3000, 1e6);
        (uint256 eb, uint256 es) = SM.matchBounds(srcAsk, srcBid, 1);
        assertEq(pb, eb);
        assertEq(ps, es);
    }

    /// Round 7: a v4 leg's fee includes the smaller direction of the Uniswap protocol fee, compounded as v4 does.
    function test_v03_v4LegFeeIncludesProtocolFee() public {
        bool coinIs0 = address(coin) < address(usd);
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(coinIs0 ? address(coin) : address(usd)),
            currency1: Currency.wrap(coinIs0 ? address(usd) : address(coin)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });
        manager.initialize(k, uint160(1 << 96));
        bytes32 v4Id = PoolId.unwrap(k.toId());
        (, uint24 f0) = BK.leg(manager, 3, address(manager), v4Id, coinIs0);
        assertEq(f0, 10_000, "no protocol fee: the LP fee");
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(k, uint24(400 | (300 << 12)));
        (, uint24 f1) = BK.leg(manager, 3, address(manager), v4Id, coinIs0);
        assertEq(f1, 300 + 10_000 - 3, "smaller direction, compounded");
        manager.setProtocolFee(k, uint24(250 | (900 << 12)));
        (, uint24 f2) = BK.leg(manager, 3, address(manager), v4Id, coinIs0);
        assertEq(f2, 250 + 10_000 - 2);
    }
}

/// @notice v0.3 cross-chain push fix (maker 2026-11-14): a push moves the centre at most minStep, and the open
///         interval settles at the worse of the old and new centre.
contract V03CrossTest is DiscipleTest {
    function _push(PoolId id) internal {
        vm.deal(address(0xC0FFEE), 1 ether);
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        DisciplePushSender.Req[] memory r = new DisciplePushSender.Req[](1);
        r[0].kind = 1;
        r[0].target = address(pair);
        r[0].pools = new PoolId[](1);
        r[0].pools[0] = id;
        uint256 fee = pushSender.quote(30101, to, r, 200_000);
        vm.prank(address(0xC0FFEE));
        pushSender.push{value: fee}(30101, to, r, 200_000);
        vm.warp(block.timestamp + 60);
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
    }

    function _create() internal returns (PoolKey memory key, PoolId id) {
        DiscipleHook.Source memory s = _src(0);
        s.remoteEid = HOME_EID;
        s.push = true;
        (key, id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: FEE,
                src: s,
                coinIn: 1000e18,
                quoteIn: 2000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
    }

    /// A home price flash-moved +20% for one push moves the centre one step (1% here), not 20%.
    function test_v03_pushedJumpIsStepCapped() public {
        (, PoolId id) = _create();
        _push(id);
        assertEq(hook.poolState(id).anchorX128, 2 * Q128, "the first price opens the pool in full");
        pair.set(1_000_000e18, 2_400_000e18); // +20%, flash-moved at home
        _push(id);
        uint256 a = hook.poolState(id).anchorX128;
        assertEq(a, Math.mulDiv(2 * Q128, 1e6 + hook.minStep(), 1e6), "one step");
        // a real move is caught up by further pushes, one step each
        for (uint256 i; i < 30; i++) _push(id);
        assertEq(hook.poolState(id).anchorX128, Math.mulDiv(2_400_000e18, Q128, 1_000_000e18), "caught up");
    }

    /// The open interval settles at the worse centre for the pool: after the pool paid out coin, a push upward values
    /// that coin at the higher centre, so no gain from the move is booked as fees.
    function test_v03_pushSettlesAtWorseCentre() public {
        (PoolKey memory key, PoolId id) = _create();
        _push(id);
        uint256 a0 = hook.poolState(id).anchorX128;
        // graduate-free check: the creator's compound class grows only by booked fees
        BalanceDelta d = _swap(key, true, -int256(50e18)); // pool pays out coin
        bool c0 = Currency.unwrap(key.currency0) == address(coin);
        uint256 c = uint256(int256(c0 ? d.amount0() : d.amount1()));
        uint256 q = uint256(int256(-(c0 ? d.amount1() : d.amount0())));
        uint256 b0 = hook.poolState(id).compounded;
        pair.set(1_000_000e18, 2_200_000e18);
        _push(id);
        uint256 a1 = hook.poolState(id).anchorX128;
        assertGt(a1, a0);
        uint256 b1 = hook.poolState(id).compounded;
        // the 1% step is more than the 0.3% the fill earned: at the new centre the fill is a loss (carried), while
        // the old centre would have booked a gain made of the price move
        assertLt(q, Math.mulDiv(c, a1, Q128, Math.Rounding.Ceil), "a loss at the new centre");
        assertGt(q, Math.mulDiv(c, a0, Q128, Math.Rounding.Ceil), "a gain at the old one");
        assertEq(b1, b0, "nothing booked as fees");
    }
}

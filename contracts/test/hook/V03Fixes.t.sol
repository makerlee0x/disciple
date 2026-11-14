// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {Vm} from "forge-std/Test.sol";
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
import {_noKey, _v02Tune} from "./NoKey.sol";

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
    /// back. v0.3 audit fix: the sell is marked at the LOWEST reading, so the push can only lower what is booked
    /// (here the fill becomes a carried loss, which stays in the pool pro rata), never raise it.
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
        uint256 a1 = hook.poolState(id).anchorX128;
        uint256 paid = _paid(id, v0.jarY + Math.mulDiv(v0.jarX, a1, Q128), a1);
        uint256 fair = Math.mulDiv(c, a0, Q128) - q;
        assertLe(paid, fair, "never more than the honest mark");
        assertEq(paid, 0, "marked at the pushed low sample: a carried loss, nothing paid");
    }

    /// M-01: trades earlier in a block, then a capital move in the same block after the leader was pushed. The
    /// capital move settles at the stored anchor; the per-fill marks are unchanged by the push.
    function test_v03_capitalMoveAfterPushIsNotRevalued() public {
        // v0.3 audit I-4: the push must come BEFORE the block's first touch (the previous version pushed after it,
        // so the sample could not move and the test passed on v0.2 too). Trades in one block, then in the next
        // block the leader is pushed and a withdraw is the first touch: v0.2 settled at a step toward the pushed
        // sample; v0.3 settles at the stored anchor, which only an earlier block's sample can move.
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        uint256 a0 = hook.poolState(id).anchorX128;
        _step(12);
        uint256 jar0 = _jar(id, a0);
        _swap(key, true, -int256(500e18));
        _swap(key, false, -int256(200e18));
        _step(12);
        uint256 snap = vm.snapshotState();
        pair.set(1_000_000e18, 2_200_000e18); // pushed +10% before this block's first touch
        hook.withdraw(id, 1, 0, 0);
        uint256 pushed = _paid(id, jar0, a0);
        vm.revertToState(snap);
        hook.withdraw(id, 1, 0, 0);
        uint256 honest = _paid(id, jar0, a0);
        assertGt(honest, 0);
        assertApproxEqRel(pushed, honest, 0.001e18, "a push before the first touch does not move the payout");
    }

    /// N-2 / audit L-4: no edge, leader fee or leader-fee mismodelling puts a fill past the leader's mid.
    function test_v03_edgeClampAtLeaderMid() public pure {
        uint256 spot = 2 * Q128;
        (,, uint256 pb, uint256 ps) = BK.sameQuote(spot, Q128, 3000, spot, 0, 1);
        assertGe(pb, spot, "ask never below the zero-fee leader's ask");
        assertLe(ps, spot, "bid never above the zero-fee leader's bid");
        // the widest edge on a leader whose stored fee overstates its real one: still never past the mid
        (,, pb, ps) = BK.sameQuote(spot, Q128, 3000, spot, 3000, 500);
        assertEq(pb, spot, "ask clamped at the mid");
        assertEq(ps, spot, "bid clamped at the mid");
        // a normal leader fee: the clamp changes nothing
        (,, pb, ps) = BK.sameQuote(spot, Q128, 3000, spot, 3000, 1);
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
                srcKey2: _noKey(),
                tune: _v02Tune()
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
        // audit I-5 / R376-02: measure the booked loss itself. Coin the pool paid out is valued at the highest of
        // the old centre, the capped new centre and the pushed price (2.2), so it is the loss at the pushed price.
        uint256 pushed = Math.mulDiv(2_200_000e18, Q128, 1_000_000e18);
        uint256 want = Math.mulDiv(c, pushed, Q128, Math.Rounding.Ceil) - q;
        assertApproxEqAbs(_lossCarry(id), want, 2, "loss booked at the pushed price");
    }

    /// @dev Book.lossCarry: pools mapping at slot 1, book at pool + 23, lossCarry at book + 3 (x, y, dx|dy first).
    function _lossCarry(PoolId id) internal view returns (uint256) {
        uint256 base = uint256(keccak256(abi.encode(PoolId.unwrap(id), uint256(1))));
        require(uint256(vm.load(address(hook), bytes32(base + 23))) == hook.poolState(id).coinReserve, "layout");
        return uint256(vm.load(address(hook), bytes32(base + 26)));
    }
}

/// @notice v0.3 creator settings (maker 2026-11-14: picked at createPool within hard bounds, then fixed).
contract V03TuneTest is DiscipleTest {
    event Tuned(PoolId indexed id, uint16 edgeBps, uint32 lamPpm, uint16 tipBps, uint16 skimBps);

    function _params(DiscipleHook.Tune memory t) internal view returns (DiscipleHook.CreateParams memory) {
        return DiscipleHook.CreateParams({
            coin: address(coin),
            quote: address(usd),
            fee: FEE,
            src: _src(0),
            coinIn: 1000e18,
            quoteIn: 2000e18,
            srcKey: _noKey(),
            srcKey2: _noKey(),
            tune: t
        });
    }

    function _make(DiscipleHook.Tune memory t) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool(_params(t));
    }

    function _bad(DiscipleHook.Tune memory t) internal {
        DiscipleHook.CreateParams memory cp = _params(t);
        vm.expectRevert();
        hook.createPool(cp);
    }

    function test_v03_tuneBounds() public {
        DiscipleHook.Tune memory t = _v02Tune();
        t.edgeBps = 501;
        _bad(t);
        t = _v02Tune();
        t.lamPpm = 4999;
        _bad(t);
        t.lamPpm = 250_001;
        _bad(t);
        t = _v02Tune();
        t.tipBps = 9999;
        _bad(t);
        t.tipBps = 15_001;
        _bad(t);
        t = _v02Tune();
        t.skimBps = 2001;
        _bad(t);
        // the bounds themselves are allowed
        _make(DiscipleHook.Tune({edgeBps: 500, lamPpm: 5000, tipBps: 10_000, skimBps: 0}));
        _make(DiscipleHook.Tune({edgeBps: 0, lamPpm: 250_000, tipBps: 15_000, skimBps: 2000}));
    }

    function test_v03_tunedEventAtCreate() public {
        DiscipleHook.Tune memory t = DiscipleHook.Tune({edgeBps: 20, lamPpm: 20_000, tipBps: 10_500, skimBps: 300});
        vm.recordLogs();
        (, PoolId id) = _make(t);
        bool seen;
        bytes32 sig = keccak256("Tuned(bytes32,uint16,uint32,uint16,uint16)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig && logs[i].topics[1] == PoolId.unwrap(id)) {
                (uint16 e, uint32 l, uint16 tp, uint16 sk) = abi.decode(logs[i].data, (uint16, uint32, uint16, uint16));
                assertEq(e, 20);
                assertEq(l, 20_000);
                assertEq(tp, 10_500);
                assertEq(sk, 300);
                seen = true;
            }
        }
        assertTrue(seen, "Tuned emitted");
    }

    /// A flatter curve (lower lam) moves less on a one-way buy, so the same buy gets more coin.
    function test_v03_flatterCurveGivesMoreOnABigBuy() public {
        DiscipleHook.Tune memory t = _v02Tune();
        (PoolKey memory k5,) = _make(t);
        t.lamPpm = 20_000;
        (PoolKey memory k2,) = _make(t);
        _nextBlock();
        bool c0 = Currency.unwrap(k5.currency0) == address(coin);
        BalanceDelta d5 = _swap(k5, true, -int256(300e18));
        BalanceDelta d2 = _swap(k2, true, -int256(300e18));
        uint256 o5 = uint256(int256(c0 ? d5.amount0() : d5.amount1()));
        uint256 o2 = uint256(int256(c0 ? d2.amount0() : d2.amount1()));
        assertGt(o2, o5, "flatter: more coin for the same quote");
    }

    /// While the anchor trails a rising leader the fill sits on the leader's bound; a wider edge lets it go further
    /// inside the leader's ask (never past its bid).
    function test_v03_widerEdgeFillsFurtherInsideTheLeader() public {
        DiscipleHook.Tune memory t = _v02Tune();
        (PoolKey memory k1,) = _make(t);
        t.edgeBps = 50;
        (PoolKey memory k50,) = _make(t);
        pair.set(1_000_000e18, 2_018_000e18); // +0.9%: both anchors trail
        _nextBlock();
        bool c0 = Currency.unwrap(k1.currency0) == address(coin);
        BalanceDelta d1 = _swap(k1, true, -int256(10e18));
        BalanceDelta d50 = _swap(k50, true, -int256(10e18));
        uint256 o1 = uint256(int256(c0 ? d1.amount0() : d1.amount1()));
        uint256 o50 = uint256(int256(c0 ? d50.amount0() : d50.amount1()));
        assertGt(o50, o1, "wider edge: a better price for the buyer");
        // still not below the leader's bid: 10 quote buys at most 10 / (2.018 * 0.997) coin
        assertLe(o50, uint256(10e18) * 1e6 * 1e6 / (2_018_000 * 997_000));
    }

    /// skim 0: trading never fills the jar.
    function test_v03_zeroSkimLeavesTheJarEmpty() public {
        vm.fee(0.01 gwei);
        DiscipleHook.Tune memory t = _v02Tune();
        t.skimBps = 0;
        (PoolKey memory key, PoolId id) = _make(t);
        for (uint256 i; i < 5; i++) {
            _nextBlock();
            uint256 c0 = coin.balanceOf(address(this));
            _swap(key, true, -int256(100e18));
            _nextBlock();
            _swap(key, false, -int256(coin.balanceOf(address(this)) - c0));
        }
        _nextBlock();
        _swap(key, true, -int256(1e12));
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertEq(v.jarX + v.jarY, 0);
    }
}

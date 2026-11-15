// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V03FixesTest, V03CrossTest} from "./V03Fixes.t.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {_noKey} from "./NoKey.sol";

/// @notice v0.3 audit fixes, same chain: each fill is marked at the least LP-favourable of the anchor, the block's
///         first-touch sample and the live spot. The reviews' reproductions (M-01, M-1, L-1, R376-03), now asserting
///         that nothing beyond what the fill earned against the leader is paid out.
contract V03AuditSameTest is V03FixesTest {
    /// M-01 (delta review): an honest sample, then the live leader moves +10% later in the block, then a buy.
    /// It used to distribute ~93.5 quote from a fill that earned ~2.9 at the live mark.
    function test_audit_postSampleMoveIsNotDistributed() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        _step(12);
        hook.sample(id); // honest first touch at 2.0
        pair.set(1_000_000e18, 2_200_000e18); // live leader +10% in the same block
        uint256 lead = Math.mulDiv(2_200_000e18, Q128, 1_000_000e18);
        uint256 jar0 = _jar(id, lead);
        BalanceDelta d = _swap(key, true, -int256(1000e18));
        (int128 dc, int128 dq) = _cq(key, d);
        uint256 q = uint256(int256(-dq));
        uint256 c = uint256(int256(dc));
        hook.withdraw(id, 1, 0, 0); // same block: the capital-path settle
        uint256 paid = _paid(id, jar0, hook.poolState(id).anchorX128);
        uint256 atLive = q - Math.mulDiv(c, lead, Q128, Math.Rounding.Ceil);
        assertLe(paid, atLive + 1, "never more than the fill earned at the live mark");
    }

    /// M-1 (organic case): first touch sees the leader at the anchor, it then really drops 0.9%, then a sell.
    function test_audit_intraBlockDropSellMarkedAtLeader() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        _step(12);
        hook.sample(id);
        pair.set(1_000_000e18, 1_982_000e18);
        uint256 lead = Math.mulDiv(1_982_000e18, Q128, 1_000_000e18);
        uint256 jar0 = _jar(id, lead);
        BalanceDelta d = _swap(key, false, -int256(500e18));
        (int128 dc, int128 dq) = _cq(key, d);
        uint256 c = uint256(int256(-dc));
        uint256 q = uint256(int256(dq));
        _step(12);
        hook.withdraw(id, 1, 0, 0);
        uint256 paid = _paid(id, jar0, lead);
        uint256 atLeader = Math.mulDiv(c, lead, Q128) - q;
        assertLe(paid, atLeader, "marked at the leader, not the anchor");
        assertApproxEqRel(paid, atLeader, 0.02e18);
    }

    /// M-1 / R376-03 (pushed case): the leader really dropped and the anchor trails; the sample is pushed above the
    /// anchor and put back, then a sell. The push can no longer lift the mark back to the anchor.
    function test_audit_pushedSampleUpCannotRaiseTheMark() public {
        (uint256 honest, uint256 atLeader) = _sellAfterDrop(false);
        assertLe(honest, atLeader + 2);
        (uint256 pushed, uint256 pushedAtLeader) = _sellAfterDrop(true);
        assertLe(pushed, pushedAtLeader + 2, "a pushed sample cannot book more than the fill earned vs the leader");
    }

    /// Mirror: the leader rose 0.9%, the sample is pushed down and put back, then a buy.
    function test_audit_pushedSampleDownCannotLowerTheBuyMark() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        pair.set(1_000_000e18, 2_018_000e18);
        uint256 lead = Math.mulDiv(2_018_000e18, Q128, 1_000_000e18);
        _step(12);
        DiscipleHook.PoolView memory v0 = hook.poolState(id);
        pair.set(1_000_000e18, 1_990_000e18);
        hook.sample(id);
        pair.set(1_000_000e18, 2_018_000e18);
        BalanceDelta d = _swap(key, true, -int256(1000e18));
        (int128 dc, int128 dq) = _cq(key, d);
        uint256 q = uint256(int256(-dq));
        uint256 c = uint256(int256(dc));
        _step(12);
        hook.withdraw(id, 1, 0, 0);
        // the payout is split into tokens at the settle's mark (the anchor took its one step toward the pushed
        // sample, as v0.2 allows), so value what was paid at that mark
        uint256 a1 = hook.poolState(id).anchorX128;
        uint256 paid = _paid(id, v0.jarY + Math.mulDiv(v0.jarX, a1, Q128), a1);
        assertLe(paid, q - Math.mulDiv(c, lead, Q128, Math.Rounding.Ceil), "never more than earned vs the leader");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Vercel review (2026-11-15)
    // ---------------------------------------------------------------------------------------------------------

    /// Vercel #3: the leader is flash-moved +20% for the block's first-touch sample and put back, then a buy. The
    /// sample is clamped to one step from the centre, so the coin paid out is marked at most 1% high and no
    /// fictitious 20% loss is carried.
    function test_vercel_flashSampleBooksNoFakeLoss() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        uint256 a0 = hook.poolState(id).anchorX128;
        _step(12);
        pair.set(1_000_000e18, 2_400_000e18); // flash +20% for the sample
        hook.sample(id);
        pair.set(1_000_000e18, 2_000_000e18); // put back
        BalanceDelta d = _swap(key, true, -int256(1000e18)); // buy 1000 coin
        (int128 dc,) = _cq(key, d);
        uint256 c = uint256(int256(dc));
        _step(12);
        hook.withdraw(id, 1, 0, 0);
        uint256 worth = Math.mulDiv(c, a0, Q128);
        assertLe(_lossCarrySame(id), worth / 100, "at most the one-step mark, not 20%");
    }

    /// Vercel #4: the reference pool (WETH/USD) is flash-moved x10 for one sample. The tip is paid at the lower of
    /// the live rate and a stored rate that moves one step per block, so it stays about the honest tip.
    function test_vercel_flashRefDoesNotInflateTip() public {
        (PoolId a, PoolId b, address bot) = _tipPools();
        vm.prank(bot);
        hook.sample(a);
        uint256 honest = usd.balanceOf(bot);
        assertGt(honest, 0, "honest tip paid");
        refPair.set(1_000e18, 30_000_000e18); // ETH flash-moved x10
        vm.prank(bot);
        hook.sample(b);
        refPair.set(1_000e18, 3_000_000e18);
        uint256 flashed = usd.balanceOf(bot) - honest;
        assertGt(flashed, 0);
        assertLt(flashed, honest * 12 / 10, "about the honest tip, not 10x");
    }

    /// Vercel #4 follow-up: a flash dip of the reference lowers only the tip paid in that block. The stored rate
    /// moves one step, so the next block's tip is back to about the honest one.
    function test_vercel_flashRefDipDoesNotSuppressLaterTips() public {
        (PoolId a, PoolId b, address bot) = _tipPools();
        vm.prank(bot);
        hook.sample(a); // the transaction's first tip (it carries the intrinsic gas), so later ones compare alike
        uint256 t0 = usd.balanceOf(bot);
        refPair.set(1_000e18, 300_000e18); // ETH flash-moved /10 for b's sample
        vm.prank(bot);
        hook.sample(b);
        refPair.set(1_000e18, 3_000_000e18);
        uint256 dipped = usd.balanceOf(bot) - t0;
        pair.set(1_000_000e18, 2_100_000e18); // both still due next block
        _step(12);
        uint256 t1 = usd.balanceOf(bot);
        vm.prank(bot);
        hook.sample(a);
        uint256 honestA = usd.balanceOf(bot) - t1;
        vm.prank(bot);
        hook.sample(b);
        uint256 afterB = usd.balanceOf(bot) - t1 - honestA;
        assertLt(dipped * 5, afterB, "the dip lowered only its own block's tip");
        assertGe(afterB * 100, honestA * 97, "next block: within a step of the honest tip");
    }

    function _tipPools() internal returns (PoolId a, PoolId b, address bot) {
        vm.fee(1 gwei);
        (, a) = _createSame(300_000e18, 600_000e18);
        (, b) = _createSame(300_000e18, 600_000e18);
        _ready(a);
        _ready(b);
        hook.fundJar(a, 0, 5000e18);
        hook.fundJar(b, 0, 5000e18);
        pair.set(1_000_000e18, 2_040_000e18); // +2%: both pools due
        _step(12);
        bot = address(0xB07);
    }

    function _lossCarrySame(PoolId id) internal view returns (uint256) {
        uint256 base = uint256(keccak256(abi.encode(PoolId.unwrap(id), uint256(1))));
        require(uint256(vm.load(address(hook), bytes32(base + 23))) == hook.poolState(id).coinReserve, "layout");
        return uint256(vm.load(address(hook), bytes32(base + 26)));
    }

    function _sellAfterDrop(bool push) internal returns (uint256 paid, uint256 atLeader) {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        _ready(id);
        hook.claim(id, 1);
        hook.claimCreator(id);
        pair.set(1_000_000e18, 1_982_000e18);
        uint256 lead = Math.mulDiv(1_982_000e18, Q128, 1_000_000e18);
        _step(12);
        DiscipleHook.PoolView memory v0 = hook.poolState(id);
        if (push) {
            pair.set(1_000_000e18, 2_010_000e18);
            hook.sample(id);
            pair.set(1_000_000e18, 1_982_000e18);
        }
        BalanceDelta d = _swap(key, false, -int256(500e18));
        (int128 dc, int128 dq) = _cq(key, d);
        uint256 c = uint256(int256(-dc));
        uint256 q = uint256(int256(dq));
        _step(12);
        hook.withdraw(id, 1, 0, 0);
        uint256 a1 = hook.poolState(id).anchorX128;
        paid = _paid(id, v0.jarY + Math.mulDiv(v0.jarX, a1, Q128), a1);
        atLeader = Math.mulDiv(c, lead, Q128) - q;
    }
}

/// @notice v0.3 audit fixes, cross chain: while the step-capped centre catches up after a real move (and right
///         after recovery from local mode), fills are bounded by the pushed price on the protective side.
contract V03AuditCrossTest is V03CrossTest {
    function _buy100(PoolKey memory key, uint256 market) internal returns (uint256 paid, uint256 worth) {
        BalanceDelta d = _swap(key, true, -int256(100e18));
        bool c0 = Currency.unwrap(key.currency0) == address(coin);
        uint256 c = uint256(int256(c0 ? d.amount0() : d.amount1()));
        paid = uint256(int256(-(c0 ? d.amount1() : d.amount0())));
        worth = Math.mulDiv(c, market, Q128);
    }

    /// M-2 / M-1: a real +20% move, one capped push lands: the pool no longer sells coin below the home price.
    function test_audit_realMoveLagIsNotArbitraged() public {
        (PoolKey memory key, PoolId id) = _create();
        _push(id);
        pair.set(1_000_000e18, 2_400_000e18);
        _push(id);
        assertLt(hook.poolState(id).anchorX128, Math.mulDiv(2_400_000e18, Q128, 1_000_000e18), "centre still capped");
        (uint256 paid, uint256 worth) = _buy100(key, Math.mulDiv(2_400_000e18, Q128, 1_000_000e18));
        assertLe(worth, paid, "no coin sold below the pushed price");
    }

    /// The same on the way down: after a real -20% move the pool does not buy coin above the pushed price.
    function test_audit_realDropLagIsNotArbitraged() public {
        (PoolKey memory key, PoolId id) = _create();
        _push(id);
        pair.set(1_000_000e18, 1_600_000e18);
        _push(id);
        uint256 market = Math.mulDiv(1_600_000e18, Q128, 1_000_000e18);
        BalanceDelta d = _swap(key, false, -int256(50e18)); // sell 50 coin to the pool
        bool c0 = Currency.unwrap(key.currency0) == address(coin);
        uint256 got = uint256(int256(c0 ? d.amount1() : d.amount0()));
        assertLe(got, Math.mulDiv(50e18, market, Q128), "no coin bought above the pushed price");
    }

    /// R376-01: recovery from local mode after a +20% move during the outage.
    function test_audit_recoveryFromLocalIsNotArbitraged() public {
        (PoolKey memory key, PoolId id) = _create();
        _push(id);
        vm.warp(block.timestamp + 2 hours + 1);
        vm.roll(block.number + 1);
        _swap(key, true, -int256(1e18));
        assertTrue(hook.poolState(id).local, "local mode");
        pair.set(1_000_000e18, 2_400_000e18);
        _push(id);
        assertFalse(hook.poolState(id).local, "recovered");
        (uint256 paid, uint256 worth) = _buy100(key, Math.mulDiv(2_400_000e18, Q128, 1_000_000e18));
        assertLe(worth, paid, "no coin sold below the pushed price right after recovery");
    }

    /// A flash-moved push only makes the pool stricter: buys still work, at or above the pushed price.
    function test_audit_flashPushOnlyTightens() public {
        (PoolKey memory key, PoolId id) = _create();
        _push(id);
        pair.set(1_000_000e18, 2_400_000e18); // flash +20% for one push
        _push(id);
        pair.set(1_000_000e18, 2_000_000e18); // put back at home
        // sells into the pool are unaffected by the high push (the bound only lifts the ask)
        BalanceDelta d = _swap(key, false, -int256(10e18));
        bool c0 = Currency.unwrap(key.currency0) == address(coin);
        assertGt(uint256(int256(c0 ? d.amount1() : d.amount0())), 0);
        // the next honest push clears it
        _push(id);
        (uint256 paid, uint256 worth) = _buy100(key, hook.poolState(id).anchorX128);
        assertLe(worth, paid);
        assertGt(worth, paid * 98 / 100, "back to a normal spread around the centre");
    }

    /// I-1: a cross-chain pool must skim something, or keepers are never refunded. Every pool now skims the
    /// fixed 6%, so the jar of a cross-chain pool fills from its earnings.
    function test_audit_crossChainSkims() public {
        (PoolKey memory key, PoolId id) = _create();
        _push(id);
        for (uint256 i; i < 6; i++) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            uint256 c0 = coin.balanceOf(address(this));
            _swap(key, true, -int256(100e18));
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            _swap(key, false, -int256(coin.balanceOf(address(this)) - c0));
            _push(id);
        }
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertGt(v.jarX + v.jarY, 0, "the jar fills from the 6% skim");
    }

    /// Vercel #1: the home price is flash-moved +20% for the very first push. The opening centre is one step from
    /// the creator's seed price, not the pushed price, and the pool still sells no coin below the pushed price.
    function test_vercel_openingPushIsStepCapped() public {
        (PoolKey memory key, PoolId id) = _create(); // seeded at 2.0
        pair.set(1_000_000e18, 2_400_000e18);
        _push(id);
        assertTrue(hook.poolState(id).live, "the push opens the pool");
        assertEq(hook.poolState(id).anchorX128, Math.mulDiv(2 * Q128, 1e6 + hook.minStep(), 1e6), "one step");
        (uint256 paid, uint256 worth) = _buy100(key, Math.mulDiv(2_400_000e18, Q128, 1_000_000e18));
        assertLe(worth, paid, "no coin sold below the pushed price");
    }

    /// Vercel #2: a cross-chain pool's fee must be at least the step (1% on Robinhood), so one manipulated push
    /// cannot move its bid further than the fee covers. 0.25% and 0.5% stay open to same-chain pools.
    function test_vercel_crossChainNeedsFeeOfAtLeastTheStep() public {
        DiscipleHook.Source memory s = _src(0);
        s.remoteEid = HOME_EID;
        s.push = true;
        uint24[4] memory fees = [uint24(2500), 5000, 10_000, 20_000];
        for (uint256 i; i < 4; i++) {
            DiscipleHook.CreateParams memory cp = DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: fees[i],
                src: s,
                coinIn: 1000e18,
                quoteIn: 2000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            });
            if (fees[i] < hook.minStep()) vm.expectRevert(DiscipleHook.BadParams.selector);
            hook.createPool(cp);
        }
    }
}

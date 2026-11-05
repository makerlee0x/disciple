// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {_noKey} from "./NoKey.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Regressions for the external review of 6b13f72 (D-01..D-03): the reviewer's reproductions, now asserting
///         the safe behaviour. Inherits DiscipleTest for its helpers (its own tests run here too).
contract ReviewFixesTest is DiscipleTest {
    /// D-01: an LP who deposits after trades in the same block gets nothing from those trades.
    function test_review_D01_lateCapitalGetsNoEarlierFees() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        vm.warp(block.timestamp + 1 days); // past the launch warm-up
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        DiscipleHook.PoolView memory v = hook.poolState(id);
        vm.prank(lp);
        (uint256 lot,) = hook.deposit(id, v.coinReserve, v.quoteReserve);
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        vm.prank(lp);
        (uint256 cx, uint256 cy) = hook.claim(id, lot);
        assertEq(cx + cy, 0, "no payout from trades before the deposit");
        // the creator's own lot did get paid for them
        (cx, cy) = hook.claim(id, 1);
        assertGt(cx + cy, 0);
    }

    /// D-01, the other direction: a withdrawal in a touched block settles the open trades first.
    function test_review_D01_sameBlockWithdrawSettlesFirst() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);
        vm.warp(block.timestamp + 1 days); // past the launch warm-up
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0); // same block
        (uint256 cx, uint256 cy) = hook.claim(id, 1);
        assertGt(cx + cy, 0, "earlier trades were closed before the capital change");
    }

    /// D-02: draining the source for one reading and restoring it earns the creator nothing.
    function test_review_D02_temporaryDrainPaysNoCreatorCut() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _nextBlock();
        pair.set(1000e18, 2000e18); // drained
        hook.withdraw(id, 1, 0, 0);
        pair.set(1_000_000e18, 2_000_000e18); // restored
        assertFalse(hook.poolState(id).creatorOn, "the previous reading still counts");
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "no creator cut");
    }

    /// D-02 re-check: the one-transaction dip repeated on consecutive blocks still pays nothing.
    function test_review_D02_repeatedAtomicDipsPayNothing() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        for (uint256 i = 0; i < 5; i++) {
            _nextBlock();
            pair.set(1000e18, 2000e18); // pull
            hook.withdraw(id, 1, 0, 0); // first touch of the block reads the low TVL
            pair.set(1_000_000e18, 2_000_000e18); // put back
            assertFalse(hook.poolState(id).creatorOn);
            vm.warp(block.timestamp + 31);
            _swap(key, true, -int256(50e18));
            _swap(key, false, -int256(20e18));
        }
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "no creator cut");
    }

    /// D-02: the gate follows a source that really stays smaller, read again and again over days.
    function test_review_D02_gateFollowsALastingDrop() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18); // 4k vs 4M source
        vm.warp(block.timestamp + 1 days);
        pair.set(1000e18, 2000e18); // the source really shrinks to 4k and stays
        uint256 n;
        uint256 t = block.timestamp; // a local clock (via-ir caches block.timestamp/number inside a test loop)
        uint256 bn = block.number;
        for (; n < 24 * 30 && !hook.poolState(id).creatorOn; n++) {
            t += 1 hours;
            vm.warp(t);
            vm.roll(++bn);
            hook.withdraw(id, 1, 0, 0);
        }
        assertTrue(hook.poolState(id).creatorOn);
        assertGt(n, 24 * 10, "takes many days of low readings");
        key;
    }

    /// D-02 second re-check (GPT on e40bff0, case 1): sit idle for days, then one atomic dip. The idle time is not
    /// banked and a single low reading is ignored, so the creator gets nothing.
    function test_review_D02_idleThenAtomicDipPaysNothing() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        vm.warp(block.timestamp + 3 days);
        _nextBlock();
        pair.set(1000e18, 2000e18);
        hook.withdraw(id, 1, 0, 0);
        pair.set(1_000_000e18, 2_000_000e18);
        assertFalse(hook.poolState(id).creatorOn);
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0); // same block
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "no creator cut");
        assertFalse(hook.poolState(id).graduated);
    }

    /// D-02 second re-check (case 1, two dips): two dips in a row after idling only lower the gate by an hour's worth.
    function test_review_D02_idleThenTwoDipsPayNothing() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        vm.warp(block.timestamp + 3 days);
        for (uint256 i = 0; i < 2; i++) {
            _nextBlock();
            pair.set(1000e18, 2000e18);
            hook.withdraw(id, 1, 0, 0);
            pair.set(1_000_000e18, 2_000_000e18);
            vm.warp(block.timestamp + 31);
            _swap(key, true, -int256(50e18));
            _swap(key, false, -int256(20e18));
        }
        assertFalse(hook.poolState(id).creatorOn);
        assertGt(hook.poolState(id).srcTvl, 0);
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "no creator cut");
    }

    /// D-02 second re-check (GPT on e40bff0, case 2): launch during an atomic dip. The low launch reading is only a
    /// floor during the one-day warm-up: nothing graduates and the creator gets nothing, and the first honest
    /// reading lifts the gate.
    function test_review_D02_launchDuringDipPaysNothing() public {
        pair.set(1000e18, 2000e18);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        pair.set(1_000_000e18, 2_000_000e18);
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0); // creation block
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        assertFalse(hook.poolState(id).graduated, "no graduation in the warm-up");
        assertFalse(hook.poolState(id).creatorOn);
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "no creator cut");
        // after the warm-up the gate holds the honest 4M reading
        vm.warp(block.timestamp + 1 days);
        _nextBlock();
        _swap(key, true, -int256(50e18));
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        assertFalse(hook.poolState(id).graduated);
        (cx, cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "still no creator cut");
    }

    /// The warm-up also covers a cross-chain pool's first pushed price.
    function test_review_D02_crossChainWarmUp() public {
        pair.set(1000e18, 2000e18); // a small source: the pool is well over 12% of it
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        uint256 t = block.timestamp;
        uint256 bn = block.number;
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID);
        vm.warp(t += 31);
        _swap(key, true, -int256(10e18));
        vm.roll(++bn);
        vm.warp(t += 12);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID);
        assertFalse(hook.poolState(id).graduated, "no graduation in the warm-up");
        vm.warp(t += 1 days);
        vm.roll(++bn);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID); // ends the local mode the quiet day put it in
        vm.warp(t += 31);
        _swap(key, true, -int256(10e18));
        vm.roll(++bn);
        vm.warp(t += 12);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID);
        assertTrue(hook.poolState(id).graduated, "graduates after it");
    }

    /// D-02: a real 12% pool still pays the creator.
    function test_review_D02_realTwelvePercentPaysCreator() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18); // 1.2M vs 4M source
        vm.warp(block.timestamp + 1 days); // past the launch warm-up
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        _nextBlock();
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertGt(cx + cy, 0);
    }

    /// D-03: price and TVL take separate decimal shifts.
    function test_review_D03_tvlShiftSeparateFromPriceShift() public {
        MockERC20 localCoin = new MockERC20("local coin", "LC", 6);
        localCoin.mint(address(this), 1000e6);
        localCoin.approve(address(hook), type(uint256).max);
        DiscipleHook.Source memory s = _pushSrc(HOME_EID);
        s.decShift = 12; // home coin 18 decimals, local 6; quote 18 on both
        s.tvlShift = 0;
        (, PoolId id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(localCoin), quote: address(usd), fee: FEE, src: s,
                coinIn: 1000e6, quoteIn: 2000e18, srcKey: _noKey(), srcKey2: _noKey()
            })
        );
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID);
        DiscipleHook.PoolView memory v = hook.poolState(id);
        assertEq(v.anchorX128, 2 * Q128 * 1e12);
        assertEq(v.srcTvl, 4_000_000e18, "TVL in local quote units");
    }

    /// D-03: out-of-range shifts are refused at creation, and same-chain pools take none.
    function test_review_D03_shiftBounds() public {
        DiscipleHook.Source memory s = _pushSrc(HOME_EID);
        s.tvlShift = -128;
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool{value: 0.01 ether}(_cp(s, _noKey()));
        s.tvlShift = 0;
        s.decShift = 37;
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool{value: 0.01 ether}(_cp(s, _noKey()));
        DiscipleHook.Source memory same = _src(0);
        same.decShift = 1;
        vm.expectRevert(DiscipleHook.BadParams.selector);
        hook.createPool(_cp(same, _noKey()));
    }
}

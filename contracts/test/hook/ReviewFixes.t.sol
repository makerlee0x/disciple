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
        _ready(id);
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        _later(31);
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
        _ready(id);
        _nextBlock();
        hook.withdraw(id, 1, 0, 0);
        _later(31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0); // same block
        (uint256 cx, uint256 cy) = hook.claim(id, 1);
        assertGt(cx + cy, 0, "earlier trades were closed before the capital change");
    }

    // ---------------------------------------------------------------------------------------------
    // D-02: source TVL pushed down or up for one transaction (review of 6b13f72 and three re-checks)
    // ---------------------------------------------------------------------------------------------

    function _later(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    /// @dev a new block `dt` seconds later
    function _step(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    /// @dev one source TVL reading: the first touch of a new block
    function _read(PoolId id) internal {
        _step(12);
        hook.withdraw(id, 1, 0, 0);
    }

    /// @dev past the warm-up, with the two honest readings the hook needs before it judges anything
    function _ready(PoolId id) internal {
        _step(1 days);
        hook.withdraw(id, 1, 0, 0);
        _read(id);
    }

    function _trade(PoolKey memory key) internal {
        _later(31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
    }

    function _creatorPaid(PoolId id) internal returns (uint256) {
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        return cx + cy;
    }

    function _big() internal {
        pair.set(1_000_000e18, 2_000_000e18); // 4M: a 4k pool is 0.1% of it, a 1.2M pool 30%
    }

    function _small() internal {
        pair.set(1000e18, 2000e18); // 4k
    }

    function _huge() internal {
        pair.set(10_000_000e18, 20_000_000e18); // 40M
    }

    /// One atomic dip earns the creator nothing.
    function test_review_D02_temporaryDrainPaysNoCreatorCut() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _ready(id);
        _step(12);
        _small();
        hook.withdraw(id, 1, 0, 0);
        _big();
        assertFalse(hook.poolState(id).creatorOn);
        _trade(key);
        _read(id);
        assertEq(_creatorPaid(id), 0);
        assertFalse(hook.poolState(id).graduated);
    }

    /// The dip repeated at the first touch of consecutive blocks still pays nothing (the memory holds).
    function test_review_D02_repeatedAtomicDipsPayNothing() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _ready(id);
        for (uint256 i = 0; i < 5; i++) {
            _step(12);
            _small();
            hook.withdraw(id, 1, 0, 0);
            _big();
            assertFalse(hook.poolState(id).creatorOn);
            _trade(key);
        }
        _read(id);
        assertEq(_creatorPaid(id), 0);
    }

    /// Re-check of e40bff0, case 1: idle for days, then one atomic dip. Pays nothing.
    function test_review_D02_idleThenAtomicDipPaysNothing() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _ready(id);
        _step(3 days);
        _small();
        hook.withdraw(id, 1, 0, 0);
        _big();
        assertFalse(hook.poolState(id).creatorOn);
        _trade(key);
        hook.withdraw(id, 1, 0, 0); // same block
        _read(id);
        assertEq(_creatorPaid(id), 0);
        assertFalse(hook.poolState(id).graduated);
    }

    /// Re-check of e40bff0, case 2: launch during an atomic dip. The launch reading never counts.
    function test_review_D02_launchDuringDipPaysNothing() public {
        _small();
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _big();
        _trade(key);
        hook.withdraw(id, 1, 0, 0); // creation block
        _read(id);
        assertFalse(hook.poolState(id).graduated, "no graduation in the warm-up");
        assertEq(_creatorPaid(id), 0);
        _step(1 days);
        _trade(key);
        _read(id);
        _read(id);
        assertFalse(hook.poolState(id).graduated);
        assertEq(_creatorPaid(id), 0);
    }

    /// Re-check of 2cf8cfc, R-01: launch during a dip, leave it untouched through the warm-up, dip again for the
    /// first touch after it. The launch reading is not one of the two readings the hook needs, so nothing happens.
    function test_review_D02_launchDipIdleDayThenDipPaysNothing() public {
        _small();
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _big();
        _step(1 days + 1);
        _small();
        hook.withdraw(id, 1, 0, 0);
        _big();
        assertFalse(hook.poolState(id).creatorOn, "two atomic lows around the launch do not count");
        assertFalse(hook.poolState(id).graduated);
        _trade(key);
        hook.withdraw(id, 1, 0, 0);
        assertEq(_creatorPaid(id), 0);
        _read(id);
        _read(id);
        assertFalse(hook.poolState(id).graduated, "the honest readings that follow hold it off");
        assertEq(_creatorPaid(id), 0);
    }

    /// Re-check of 2cf8cfc, R-02: one spiked reading delays graduation by two readings, not for weeks, and the
    /// delay does not depend on how often the pool is touched.
    function test_review_D02_oneHighReadingDelaysGraduationTwoReadings() public {
        (PoolKey memory attackedKey, PoolId attacked) = _createSame(300_000e18, 600_000e18);
        (, PoolId control) = _createSame(300_000e18, 600_000e18);
        _ready(control);
        _ready(attacked);
        assertTrue(hook.poolState(control).graduated, "control graduates");
        // the same again from a fresh pair, with the spike on the first judged reading
        (attackedKey, attacked) = _createSame(300_000e18, 600_000e18);
        _step(1 days);
        hook.withdraw(attacked, 1, 0, 0); // reading 1
        _step(12);
        _huge();
        _swap(attackedKey, true, -int256(1e18)); // reading 2, spiked
        _big();
        assertFalse(hook.poolState(attacked).graduated, "the spike holds it back");
        _step(1 days);
        hook.withdraw(attacked, 1, 0, 0); // still paired with the spike
        assertFalse(hook.poolState(attacked).graduated);
        _step(1 days);
        hook.withdraw(attacked, 1, 0, 0); // two honest readings
        assertTrue(hook.poolState(attacked).graduated, "graduates two readings later");
    }

    /// The mirror of the dip: two spiked readings in a row turn the creator cut off for at most a day of real
    /// time, however rarely the pool is touched; one spike does nothing to it.
    function test_review_D02_spikesDelayCreatorCutAtMostADay() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18); // 1.2M vs 4M
        _ready(id);
        assertTrue(hook.poolState(id).creatorOn);
        _step(12);
        _huge();
        hook.withdraw(id, 1, 0, 0); // one spike: does nothing to the cut
        _big();
        assertTrue(hook.poolState(id).creatorOn);
        _read(id);
        assertTrue(hook.poolState(id).creatorOn, "one spike never turns the cut off");
        // two spikes in a row: remembered, fading over a day
        for (uint256 i = 0; i < 2; i++) {
            _step(12);
            _huge();
            hook.withdraw(id, 1, 0, 0);
            _big();
        }
        _read(id);
        _read(id);
        assertFalse(hook.poolState(id).creatorOn, "two spikes are remembered");
        _step(1 days);
        _trade(key);
        hook.withdraw(id, 1, 0, 0);
        assertTrue(hook.poolState(id).creatorOn, "back after a day, with one touch");
        _read(id);
        assertGt(_creatorPaid(id), 0);
    }

    /// A source that really shrinks: on a busy pool (readings every hour) the cut comes back within about a day.
    function test_review_D02_lastingDropBusyPool() public {
        (, PoolId id) = _createSame(1000e18, 2000e18);
        _ready(id);
        _small(); // and it stays small
        uint256 n;
        for (; n < 48 && !hook.poolState(id).creatorOn; n++) {
            _step(1 hours);
            hook.withdraw(id, 1, 0, 0);
        }
        assertTrue(hook.poolState(id).creatorOn);
        assertGe(n, 20, "not before the memory has faded");
        assertLe(n, 25, "within about a day");
    }

    /// The same on a quiet pool touched once a day: real time counts, not touches.
    function test_review_D02_lastingDropQuietPool() public {
        (, PoolId id) = _createSame(1000e18, 2000e18);
        _ready(id);
        _small();
        _step(1 days);
        hook.withdraw(id, 1, 0, 0);
        assertFalse(hook.poolState(id).creatorOn, "one low reading is not enough");
        _step(1 days);
        hook.withdraw(id, 1, 0, 0);
        assertTrue(hook.poolState(id).creatorOn, "two low readings a day apart");
    }

    /// Re-check of 10d7437, R-01: one spiked reading while fees are waiting does not divert the creator's cut.
    function test_review_D02_oneSpikeDoesNotDivertTheCreatorCut() public {
        (PoolKey memory aKey, PoolId a) = _createSame(300_000e18, 600_000e18);
        (PoolKey memory cKey, PoolId c) = _createSame(300_000e18, 600_000e18);
        _ready(a);
        hook.withdraw(c, 1, 0, 0);
        _read(c);
        _read(a);
        hook.withdraw(c, 1, 0, 0);
        hook.claimCreator(a);
        hook.claimCreator(c);
        _trade(aKey);
        _swap(cKey, true, -int256(50e18));
        _swap(cKey, false, -int256(20e18));
        _step(12);
        _huge();
        hook.withdraw(a, 1, 0, 0); // the attacked pool settles on a spiked reading
        _big();
        hook.withdraw(c, 1, 0, 0); // the control on an honest one
        uint256 pa = _creatorPaid(a);
        uint256 pc = _creatorPaid(c);
        assertGt(pc, 0);
        assertEq(pa, pc, "the spike changes nothing");
    }

    /// The accepted residual (AUDIT_BRIEF): after a full day with no honest pair of readings, two dips in a row turn
    /// the cut on, and it stays on until two honest readings in a row, so keeping it takes a dip at one of every
    /// two touches.
    function test_review_D02_residualNeedsEveryTouch() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        _ready(id);
        _step(1 days);
        for (uint256 i = 0; i < 2; i++) {
            _step(12);
            _small();
            hook.withdraw(id, 1, 0, 0);
            _big();
        }
        assertTrue(hook.poolState(id).creatorOn, "the residual: two dips after a quiet day");
        _read(id); // one honest reading
        assertTrue(hook.poolState(id).creatorOn, "one reading alone never flips it");
        _read(id); // two in a row
        assertFalse(hook.poolState(id).creatorOn, "two honest readings in a row end it");
        hook.claimCreator(id);
        _trade(key);
        _step(12);
        _small(); // a dip at the next touch does not bring it back: the memory holds the honest pair
        hook.withdraw(id, 1, 0, 0);
        _big();
        assertFalse(hook.poolState(id).creatorOn);
        assertEq(_creatorPaid(id), 0, "no cut on the honest block's fees");
    }

    /// The warm-up and the two-reading rule also cover a cross-chain pool's pushed prices.
    function test_review_D02_crossChainWarmUp() public {
        _small(); // a small source: the pool is well over 12% of it
        (PoolKey memory key, PoolId id) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID); // first price: never counts
        _trade(key);
        _step(12);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID);
        assertFalse(hook.poolState(id).graduated, "no graduation in the warm-up");
        _step(1 days);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID); // ends the local mode the quiet day put it in
        _trade(key);
        _step(12);
        _lzPush(id, address(0xC0FFEE), 0, HOME_EID);
        assertTrue(hook.poolState(id).graduated, "graduates after it");
    }

    /// An honest 12% pool still pays the creator.
    function test_review_D02_realTwelvePercentPaysCreator() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18); // 1.2M vs 4M source
        _ready(id);
        assertTrue(hook.poolState(id).graduated);
        _trade(key);
        _read(id);
        assertGt(_creatorPaid(id), 0);
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleTest} from "./Disciple.t.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {_noKey} from "./NoKey.sol";

/// @notice Pre-redeploy competitiveness gate. Measurement only: it does not change pricing rules.
///         Numbers are logged with -vv. bps are integer basis points versus the named reference.
contract CompetitivenessGateTest is DiscipleTest {
    uint256 internal constant COIN = 100_000e18;
    uint256 internal constant QUOTE = 200_000e18;

    function _advance(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        if (dt != 0) vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _createFee(uint24 fee, uint256 coinIn, uint256 quoteIn) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: fee,
                src: _src(0),
                coinIn: coinIn,
                quoteIn: quoteIn,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
    }

    function _deep(uint24 fee) internal returns (PoolKey memory key, PoolId id) {
        return _createFee(fee, COIN, QUOTE);
    }

    /// @dev Lag premium in bps. Matches DiscipleSwapMath.premium(4e16, 30, elapsed), then (H-1) in bps.
    function _lagBps(uint64 premAt) internal view returns (uint256) {
        uint256 elapsed = vm.getBlockTimestamp() - premAt;
        if (elapsed >= 30) return 0;
        uint256 h = 1e18 + Math.mulDiv(4e16, 30 - elapsed, 30, Math.Rounding.Ceil);
        return (h - 1e18) * 10_000 / 1e18;
    }

    function _srcMid() internal view returns (uint256) {
        return Math.mulDiv(uint256(pair.r1()), Q128, uint256(pair.r0()));
    }

    function _fill(PoolKey memory key, bool buy, uint256 amountIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        uint256 ts = vm.getBlockTimestamp();
        uint256 bn = vm.getBlockNumber();
        uint256 b0 = (buy ? coin : usd).balanceOf(address(this));
        _swap(key, buy, -int256(amountIn));
        out = (buy ? coin : usd).balanceOf(address(this)) - b0;
        vm.revertToState(snap);
        vm.warp(ts);
        vm.roll(bn);
    }

    function _overBps(uint256 execX128, uint256 refX128) internal pure returns (int256) {
        if (execX128 >= refX128) return int256(Math.mulDiv(execX128 - refX128, 10_000, refX128));
        return -int256(Math.mulDiv(refX128 - execX128, 10_000, refX128));
    }

    function _quote(string memory tag, PoolKey memory key, PoolId id) internal {
        DiscipleHook.PoolView memory v = hook.poolState(id);
        uint256 qIn = 1e18;
        uint256 cIn = 0.5e18;
        uint256 cOut = _fill(key, true, qIn);
        uint256 qOut = _fill(key, false, cIn);
        uint256 buyX = Math.mulDiv(qIn, Q128, cOut);
        uint256 sellX = Math.mulDiv(qOut, Q128, cIn);
        console2.log(tag);
        console2.log("  ts", vm.getBlockTimestamp());
        console2.log("  premAt", uint256(v.premAt));
        console2.log("  sampleAt", uint256(v.sampleAt));
        console2.log("  elapsed", vm.getBlockTimestamp() - v.premAt);
        console2.log("  premBuy", v.premBuy ? uint256(1) : uint256(0));
        console2.log("  lagBps", _lagBps(v.premAt));
        console2.log("  anchor", v.anchorX128);
        console2.log("  srcMid", _srcMid());
        console2.log("  buyBpsVsAnchor", _overBps(buyX, v.anchorX128));
        console2.log("  sellBpsVsAnchor", _overBps(v.anchorX128, sellX));
        console2.log("  buyBpsVsSrc", _overBps(buyX, _srcMid()));
        console2.log("  sellBpsVsSrc", _overBps(_srcMid(), sellX));
    }

    /// @dev Clear the opening window, record a moved spot, and adopt it with elapsed 0 (same timestamp, next block).
    function _arm(uint112 quoteReserve) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = _deep(FEE);
        _advance(60);
        hook.sample(id);
        pair.set(1_000_000e18, quoteReserve);
        _advance(1);
        hook.sample(id);
        vm.roll(vm.getBlockNumber() + 1);
        hook.sample(id);
    }

    function test_gate1_quietSampleThenLaterSwap() public {
        (PoolKey memory key, PoolId id) = _deep(FEE);
        _quote("G1_create_opening", key, id);
        _advance(60);
        hook.sample(id);
        _quote("G1_after_60s_sample_no_move", key, id);

        pair.set(1_000_000e18, 2_020_000e18);
        _advance(10 minutes);
        _quote("G1_quiet_10min_before_recording_sample", key, id);
        hook.sample(id);
        uint64 recorded = uint64(vm.getBlockTimestamp());
        DiscipleHook.PoolView memory v = hook.poolState(id);
        console2.log("G1_recorded_sampleAt", uint256(v.sampleAt));
        console2.log("G1_recorded_premAt_still_old", uint256(v.premAt));
        assertEq(v.sampleAt, recorded, "sample stored the move");
        assertLt(v.premAt, recorded, "recording does not arm");

        vm.roll(vm.getBlockNumber() + 1);
        hook.sample(id);
        v = hook.poolState(id);
        assertEq(v.premAt, recorded, "premAt is the sample time");
        assertEq(_lagBps(v.premAt), 400, "full 4% at the sample timestamp");
        assertTrue(v.premBuy);
        _quote("G1_adopt_elapsed_0", key, id);

        _advance(15);
        hook.sample(id);
        assertEq(hook.poolState(id).premAt, recorded, "15s sample does not restart");
        assertEq(_lagBps(recorded), 200);
        _quote("G1_15s", key, id);

        _advance(15);
        hook.sample(id);
        assertEq(_lagBps(hook.poolState(id).premAt), 0);
        _quote("G1_30s_faded", key, id);

        _advance(5 minutes);
        uint256 c30 = _fill(key, true, 1e18);
        _advance(10 minutes);
        uint256 c15m = _fill(key, true, 1e18);
        _advance(15 minutes);
        uint256 c30m = _fill(key, true, 1e18);
        console2.log("G1_buy_out_1quote_at_5min", c30);
        console2.log("G1_buy_out_1quote_at_15min", c15m);
        console2.log("G1_buy_out_1quote_at_30min", c30m);
        assertEq(c30, c15m, "premium stays faded");
        assertEq(c15m, c30m, "premium stays faded");
        assertEq(hook.poolState(id).premAt, recorded, "later samples do not restart a quiet clock");
    }

    function test_gate2_quietNoSampleDirection() public {
        _movePath("G2_up", 2_020_000e18, true, false, 10 minutes);
        _movePath("G2_down", 1_980_000e18, false, false, 10 minutes);
    }

    function test_gate3_busyDirectionAndDecay() public {
        _movePath("G3_up_nosample", 2_020_000e18, true, false, 2);
        _movePath("G3_up_sample", 2_020_000e18, true, true, 2);
        _movePath("G3_down_nosample", 1_980_000e18, false, false, 2);
        _movePath("G3_down_sample", 1_980_000e18, false, true, 2);
    }

    /// @dev Price moves, then `gap` seconds pass. The recording touch and the adopting touch are swaps,
    ///      or sample() when `useSample` is set. Premium is charged only on the favored side, then fades.
    function _movePath(string memory tag, uint112 quoteReserve, bool expectBuy, bool useSample, uint256 gap) internal {
        pair.set(1_000_000e18, 2_000_000e18);
        (PoolKey memory key, PoolId id) = _deep(FEE);
        _advance(60);
        hook.sample(id);
        pair.set(1_000_000e18, quoteReserve);
        _advance(gap);
        _quote(string.concat(tag, "_touch1_records"), key, id);
        if (useSample) hook.sample(id);
        else _swap(key, true, -int256(1e18));
        _advance(gap > 2 ? 1 : gap);
        if (useSample) hook.sample(id);
        else _swap(key, false, -int256(0.5e18));
        _quote(string.concat(tag, "_touch2_arms"), key, id);
        DiscipleHook.PoolView memory v = hook.poolState(id);
        console2.log(string.concat(tag, "_premBuy"), v.premBuy ? uint256(1) : uint256(0));
        console2.log(string.concat(tag, "_lag"), _lagBps(v.premAt));
        assertEq(v.premBuy, expectBuy, "premium side follows the move");
        assertGt(_lagBps(v.premAt), 300, "adopting touch is still inside the 30s window");
        _sides(tag, key, id, true);

        uint64 armedAt = v.premAt;
        _advance(30);
        if (useSample) hook.sample(id);
        else _swap(key, true, -int256(1e18));
        v = hook.poolState(id);
        console2.log(string.concat(tag, "_after30_lag"), _lagBps(v.premAt));
        console2.log(string.concat(tag, "_after30_premAt"), uint256(v.premAt));
        assertEq(v.premAt, armedAt, "later touches of the same price do not restart");
        assertEq(_lagBps(v.premAt), 0, "faded");
        _sides(tag, key, id, false);
    }

    /// @dev 1 quote buy and 0.5 coin sell. When `fresh` the favored side is hundreds of bps and the other is fee-only.
    function _sides(string memory tag, PoolKey memory key, PoolId id, bool fresh) internal {
        DiscipleHook.PoolView memory v = hook.poolState(id);
        uint256 cOut = _fill(key, true, 1e18);
        uint256 qOut = _fill(key, false, 0.5e18);
        int256 buyBps = _overBps(Math.mulDiv(1e18, Q128, cOut), v.anchorX128);
        int256 sellBps = _overBps(v.anchorX128, Math.mulDiv(qOut, Q128, 0.5e18));
        console2.log(string.concat(tag, fresh ? "_fresh_buyBps" : "_faded_buyBps"), buyBps);
        console2.log(string.concat(tag, fresh ? "_fresh_sellBps" : "_faded_sellBps"), sellBps);
        if (fresh && v.premBuy) {
            assertGt(buyBps, 200, "buy pays the lag");
            assertLt(sellBps, 80, "sell is fee-only");
        } else if (fresh) {
            assertGt(sellBps, 200, "sell pays the lag");
            assertLt(buyBps, 80, "buy is fee-only");
        } else {
            assertLt(buyBps, 80, "buy faded");
            assertLt(sellBps, 80, "sell faded");
        }
    }

    function test_gate4_sameObservationDoesNotRestart() public {
        (PoolKey memory key, PoolId id) = _arm(2_020_000e18);
        uint64 armed = hook.poolState(id).premAt;
        assertEq(_lagBps(armed), 400);
        uint256[4] memory wait = [uint256(0), 10, 20, 40];
        for (uint256 i = 0; i < wait.length; i++) {
            if (wait[i] != 0) _advance(wait[i] - (i == 0 ? 0 : wait[i - 1]));
            _swap(key, true, -int256(1e18));
            DiscipleHook.PoolView memory v = hook.poolState(id);
            console2.log("G4_swap", i);
            console2.log("  ts", vm.getBlockTimestamp());
            console2.log("  premAt", uint256(v.premAt));
            console2.log("  sampleAt", uint256(v.sampleAt));
            console2.log("  lagBps", _lagBps(v.premAt));
            assertEq(v.premAt, armed, "swap on the same observation does not restart");
        }
        assertEq(_lagBps(armed), 0, "clock ran out from the original sample");

        // 10 bps further move is under the 25 bps reset. 30 bps crosses it.
        uint64 before = hook.poolState(id).premAt;
        pair.set(1_000_000e18, 2_022_020e18);
        _advance(1);
        hook.sample(id);
        _advance(0);
        // _advance(0) still rolls. The 10 bps sample is adopted here.
        hook.sample(id);
        console2.log("G4_after_10bps_premAt", uint256(hook.poolState(id).premAt));
        assertEq(hook.poolState(id).premAt, before, "10 bps does not re-arm");

        pair.set(1_000_000e18, 2_026_060e18); // +30 bps from 2.02
        _advance(1);
        hook.sample(id);
        uint64 movedAt = uint64(vm.getBlockTimestamp());
        vm.roll(vm.getBlockNumber() + 1);
        hook.sample(id);
        console2.log("G4_after_30bps_premAt", uint256(hook.poolState(id).premAt));
        console2.log("G4_after_30bps_lag", _lagBps(hook.poolState(id).premAt));
        assertEq(hook.poolState(id).premAt, movedAt, "30 bps re-arms from that sample");
        assertEq(_lagBps(movedAt), 400);
    }

    function test_gate5_sameTxManipulationAndPush() public {
        (PoolKey memory key, PoolId id) = _deep(FEE);
        _advance(60);
        hook.sample(id);
        uint256 anchor = hook.poolState(id).anchorX128;
        uint256 honest = _fill(key, true, 100e18);
        uint256 honestSell = _fill(key, false, 50e18);

        uint256 snap = vm.snapshotState();
        uint256 ts = vm.getBlockTimestamp();
        uint256 bn = vm.getBlockNumber();
        pair.set(1_000_000e18, 10_000_000e18);
        uint256 pumped = _fill(key, true, 100e18);
        uint256 pumpedSell = _fill(key, false, 50e18);
        console2.log("G5_same_block_honest_buy", honest);
        console2.log("G5_same_block_pumped_buy", pumped);
        console2.log("G5_same_block_honest_sell", honestSell);
        console2.log("G5_same_block_pumped_sell", pumpedSell);
        assertEq(hook.poolState(id).anchorX128, anchor, "same-block pump does not move the anchor");
        assertLt(pumped, honest, "buy match-bound follows the pumped spot");

        vm.revertToState(snap);
        vm.warp(ts);
        vm.roll(bn);
        pair.set(1_000_000e18, 10_000_000e18);
        _advance(1);
        uint256 coins = _fill(key, true, 100e18);
        _swap(key, true, -int256(100e18));
        DiscipleHook.PoolView memory v = hook.poolState(id);
        console2.log("G5_next_block_pumped_buy", coins);
        console2.log("G5_next_block_anchor", v.anchorX128);
        assertEq(v.anchorX128, anchor, "adopted anchor is the pre-pump sample");
        assertLt(coins, honest, "next-block buy still faces the live pumped bound");

        // One dipped TVL reading on a real settle (not sample) does not graduate a pool far under 12%.
        pair.set(1_000_000e18, 2_000_000e18);
        (, PoolId small) = _createSame(1000e18, 2000e18);
        _advance(1 days);
        hook.withdraw(small, 1, 0, 0);
        _advance(12);
        pair.set(1000e18, 2000e18);
        hook.withdraw(small, 1, 0, 0);
        pair.set(1_000_000e18, 2_000_000e18);
        v = hook.poolState(small);
        console2.log("G5_dip_graduated", v.graduated ? uint256(1) : uint256(0));
        console2.log("G5_dip_creator", v.creatorOn ? uint256(1) : uint256(0));
        console2.log("G5_dip_srcTvl", v.srcTvl);
        assertFalse(v.graduated, "one same-tx dip does not graduate");
        assertFalse(v.creatorOn, "one same-tx dip does not turn the cut on");

        // Same-timestamp second push is ignored. A direct push reverts.
        pair.set(1_000_000e18, 2_000_000e18);
        (, PoolId pid) = _createPush(HOME_EID, 0.05 ether);
        _lzPush(pid, address(0xC0FFEE), 1, HOME_EID);
        uint256 a0 = hook.poolState(pid).anchorX128;
        bytes32 to = bytes32(uint256(uint160(address(receiver))));
        uint256 fee = pushSender.quote(30101, to, _req(address(pair), pid), 200_000);
        pushSender.push{value: fee}(30101, to, _req(address(pair), pid), 200_000);
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        uint256 a1 = hook.poolState(pid).anchorX128;
        pair.set(1_000_000e18, 4_000_000e18);
        fee = pushSender.quote(30101, to, _req(address(pair), pid), 200_000);
        pushSender.push{value: fee}(30101, to, _req(address(pair), pid), 200_000);
        local.deliver(address(receiver), HOME_EID, address(pushSender), home.lastMessage());
        uint256 a2 = hook.poolState(pid).anchorX128;
        console2.log("G5_push_open_anchor", a0);
        console2.log("G5_push_first_same_ts", a1);
        console2.log("G5_push_replay_same_ts", a2);
        assertEq(a2, a1, "same-timestamp push is ignored");
        vm.expectRevert(DiscipleHook.OnlyBridge.selector);
        hook.onBridgePrice(
            pid, HOME_EID, 1, address(pair), bytes32(0), 1e18, 9e18, uint64(vm.getBlockTimestamp()), address(this), 0
        );
    }

    function test_gate6_sampleIsPriceOnly() public {
        (PoolKey memory key, PoolId id) = _deep(FEE);
        DiscipleHook.PoolView memory pre = hook.poolState(id);
        _advance(1);
        hook.sample(id);
        DiscipleHook.PoolView memory post = hook.poolState(id);
        _logView("G6_before", pre);
        _logView("G6_after_one_sample", post);
        assertEq(post.coinReserve, pre.coinReserve, "reserves unchanged");
        assertEq(post.quoteReserve, pre.quoteReserve, "reserves unchanged");
        assertEq(post.principal, pre.principal);
        assertEq(post.compounded, pre.compounded);
        assertEq(post.lots, pre.lots);
        assertEq(post.graduated, pre.graduated);
        assertEq(post.creatorOn, pre.creatorOn);
        assertEq(post.ageOrBlock, pre.ageOrBlock, "settledBlock unchanged");
        assertEq(post.srcTvl, pre.srcTvl, "sample does not observe TVL");
        assertGt(post.sampleAt, pre.sampleAt, "the price sample moved");
        _swap(key, true, -int256(1e18));
        assertGt(hook.poolState(id).ageOrBlock, pre.ageOrBlock, "a swap in the sample's block still settles");

        (PoolKey memory bigKey, PoolId big) = _createSame(300_000e18, 600_000e18);
        uint256 settled = hook.poolState(big).ageOrBlock;
        uint256 tvl = hook.poolState(big).srcTvl;
        _advance(1);
        hook.sample(big);
        _advance(1 days);
        hook.sample(big);
        DiscipleHook.PoolView memory g = hook.poolState(big);
        _logView("G6_after_warmup_samples", g);
        console2.log("G6_graduated", g.graduated ? uint256(1) : uint256(0));
        assertFalse(g.graduated, "samples do not graduate");
        assertFalse(g.creatorOn, "samples do not turn the creator cut on");
        assertEq(g.ageOrBlock, settled, "samples do not settle");
        assertEq(g.srcTvl, tvl, "samples do not observe TVL");
        assertEq(g.coinReserve, 300_000e18);
        assertEq(g.quoteReserve, 600_000e18);
        assertEq(g.principal, 1_200_000e18);
        assertEq(g.compounded, 0);
        assertEq(g.lots, 1);
        _advance(1);
        _swap(bigKey, true, -int256(1e18));
        assertFalse(hook.poolState(big).graduated, "one swap reading is not enough");
        _advance(1);
        _swap(bigKey, true, -int256(1e18));
        g = hook.poolState(big);
        assertTrue(g.graduated, "swaps still settle and can graduate");
        assertTrue(g.creatorOn, "swaps still judge the creator cut");
        console2.log("G6_after_two_swaps_graduated", g.graduated ? uint256(1) : uint256(0));
        console2.log("G6_after_two_swaps_settled", g.ageOrBlock);
    }

    function _logView(string memory tag, DiscipleHook.PoolView memory v) internal pure {
        console2.log(tag);
        console2.log("  coin", v.coinReserve);
        console2.log("  quote", v.quoteReserve);
        console2.log("  graduated", v.graduated ? uint256(1) : uint256(0));
        console2.log("  creator", v.creatorOn ? uint256(1) : uint256(0));
        console2.log("  settledBlock", v.ageOrBlock);
        console2.log("  srcTvl", v.srcTvl);
        console2.log("  premAt", uint256(v.premAt));
        console2.log("  sampleAt", uint256(v.sampleAt));
        console2.log("  principal", v.principal);
        console2.log("  compounded", v.compounded);
        console2.log("  lots", v.lots);
    }

    function test_gate7_localIdleQuotes() public {
        (PoolKey memory key, PoolId id) = _deep(FEE);
        _advance(60);
        hook.sample(id);
        pair.set(1_000_000e18, 2_020_000e18);
        uint256 snap = vm.snapshotState();
        uint256 ts = vm.getBlockTimestamp();
        uint256 bn = vm.getBlockNumber();

        uint256[3] memory idle = [uint256(5 minutes), 15 minutes, 30 minutes];
        for (uint256 i = 0; i < idle.length; i++) {
            vm.revertToState(snap);
            vm.warp(ts);
            vm.roll(bn);
            _advance(1);
            hook.sample(id);
            uint64 recorded = uint64(vm.getBlockTimestamp());
            _advance(idle[i]);
            hook.sample(id);
            console2.log("G7_with_sample_idle_sec", idle[i]);
            console2.log("  premAt", uint256(hook.poolState(id).premAt));
            console2.log("  lagBps", _lagBps(hook.poolState(id).premAt));
            assertEq(hook.poolState(id).premAt, recorded);
            assertEq(_lagBps(recorded), 0);
            _quote("G7_with_sample", key, id);
        }
        for (uint256 i = 0; i < idle.length; i++) {
            vm.revertToState(snap);
            vm.warp(ts);
            vm.roll(bn);
            _advance(idle[i]);
            console2.log("G7_no_sample_idle_sec", idle[i]);
            _quote("G7_no_sample_first_touch", key, id);
            _swap(key, true, -int256(1e18));
            _advance(1);
            _swap(key, false, -int256(0.5e18));
            console2.log("  second_touch_lagBps", _lagBps(hook.poolState(id).premAt));
            console2.log("  second_touch_premAt", uint256(hook.poolState(id).premAt));
            console2.log("  second_touch_ts", vm.getBlockTimestamp());
            console2.log("  second_touch_premBuy", hook.poolState(id).premBuy ? uint256(1) : uint256(0));
            _quote("G7_no_sample_second_touch", key, id);
            assertGt(_lagBps(hook.poolState(id).premAt), 300, "no sample: the clock starts at the first swap");
            assertTrue(hook.poolState(id).premBuy);
        }
    }

    function test_gate8_feeMatrix() public {
        uint24[3] memory ours = [uint24(3000), 5000, 10_000];
        uint24[4] memory srcFee = [uint24(1000), 3000, 5000, 10_000];
        uint256[4] memory usd = [uint256(1e18), 100e18, 1000e18, 10_000e18];
        PoolKey[3] memory keys;
        PoolId[3] memory ids;
        for (uint256 i = 0; i < ours.length; i++) {
            (keys[i], ids[i]) = _deep(ours[i]);
        }
        _advance(60);
        for (uint256 i = 0; i < ours.length; i++) {
            hook.sample(ids[i]);
        }
        _matrix("faded", keys, ids, ours, srcFee, usd);

        pair.set(1_000_000e18, 2_020_000e18);
        _advance(1);
        for (uint256 i = 0; i < ours.length; i++) {
            hook.sample(ids[i]);
        }
        vm.roll(vm.getBlockNumber() + 1);
        for (uint256 i = 0; i < ours.length; i++) {
            hook.sample(ids[i]);
        }
        assertEq(_lagBps(hook.poolState(ids[0]).premAt), 400);
        _matrix("fresh400buy", keys, ids, ours, srcFee, usd);
    }

    function _matrix(
        string memory state,
        PoolKey[3] memory keys,
        PoolId[3] memory ids,
        uint24[3] memory ours,
        uint24[4] memory srcFee,
        uint256[4] memory usd
    ) internal {
        uint256 srcCoin = uint256(pair.r0());
        uint256 srcQuote = uint256(pair.r1());
        uint256 secCoin = srcCoin / 100;
        uint256 secQuote = srcQuote / 100;
        for (uint256 i = 0; i < ours.length; i++) {
            for (uint256 j = 0; j < srcFee.length; j++) {
                for (uint256 k = 0; k < usd.length; k++) {
                    uint256 coinIn = usd[k] / 2;
                    uint256 usBuy = _fill(keys[i], true, usd[k]);
                    uint256 usSell = _fill(keys[i], false, coinIn);
                    uint256 srcBuy = _cp(srcQuote, srcCoin, usd[k], srcFee[j]);
                    uint256 srcSell = _cp(srcCoin, srcQuote, coinIn, srcFee[j]);
                    uint256 secBuy = _cp(secQuote, secCoin, usd[k], srcFee[j]);
                    uint256 secSell = _cp(secCoin, secQuote, coinIn, srcFee[j]);
                    console2.log(state);
                    console2.log("  ourFee", uint256(ours[i]));
                    console2.log("  srcFee", uint256(srcFee[j]));
                    console2.log("  usd", usd[k] / 1e18);
                    console2.log("  premBuy", hook.poolState(ids[i]).premBuy ? uint256(1) : uint256(0));
                    console2.log("  lagBps", _lagBps(hook.poolState(ids[i]).premAt));
                    console2.log("  usBuy", usBuy);
                    console2.log("  srcBuy", srcBuy);
                    console2.log("  secBuy", secBuy);
                    console2.log("  winBuy", _best(usBuy, srcBuy, secBuy));
                    console2.log("  usSell", usSell);
                    console2.log("  srcSell", srcSell);
                    console2.log("  secSell", secSell);
                    console2.log("  winSell", _best(usSell, srcSell, secSell));
                }
            }
        }
    }

    /// @dev Constant-product output, fee in pips, round down. 1 = us, 2 = source, 3 = secondary.
    function _cp(uint256 reserveIn, uint256 reserveOut, uint256 amountIn, uint24 feePips)
        internal
        pure
        returns (uint256)
    {
        uint256 dx = Math.mulDiv(amountIn, 1e6 - feePips, 1e6);
        return Math.mulDiv(reserveOut, dx, reserveIn + dx);
    }

    function _best(uint256 us, uint256 src, uint256 sec) internal pure returns (uint256) {
        if (us >= src && us >= sec) return 1;
        if (src >= sec) return 2;
        return 3;
    }
}

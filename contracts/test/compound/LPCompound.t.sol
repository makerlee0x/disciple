// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Atomic sandwich: swap, try flush, swap back — all in one tx.
contract Sandwicher {
    function run(PoolSwapTest r, PoolKey memory key, LockedLP lp, address token, IERC20 quote, IERC20 tok, bool zfoBuy)
        external
        returns (bool flushReverted)
    {
        quote.approve(address(r), type(uint256).max);
        tok.approve(address(r), type(uint256).max);
        _swap(r, key, zfoBuy, quote.balanceOf(address(this)));
        try lp.flush(token) {} catch {
            flushReverted = true;
        }
        _swap(r, key, !zfoBuy, tok.balanceOf(address(this)));
    }

    function _swap(PoolSwapTest r, PoolKey memory key, bool zfo, uint256 amt) internal {
        r.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zfo,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}

contract LPCompoundTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes32 constant COMPOUNDED = keccak256("LiquidityCompounded(address,uint128,uint256,uint256,uint256,uint256)");
    bytes32 constant FAILED = keccak256("CompoundFailed(address)");

    Token tok;
    Token tokB;

    function _grad() internal returns (Token t) {
        (BondingCurve c, Token t_) = _launch(0, 0);
        _graduate(c);
        t = t_;
    }

    function _params(uint32 minPpm, uint32 maxPpm, uint16 dev) internal {
        vm.prank(owner);
        lockedLP.setCompoundParams(minPpm, maxPpm, dev);
    }

    function _bucket(Token t) internal view returns (uint256 b0, uint256 b1) {
        return lockedLP.compoundBucket(address(t));
    }

    function _liq(Token t) internal view returns (uint128 l) {
        (,,,,,, l) = lockedLP.positions(address(t));
    }

    function _v4Liq(Token t) internal view returns (uint128 l) {
        (int24 tl, int24 tu, bytes32 salt) = lockedLP.positionTicks(address(t));
        (l,,) = manager.getPositionInfo(_poolKey(t).toId(), address(lockedLP), tl, tu, salt);
    }

    /// @dev Exact accounting: LockedLP balances == sum of buckets (all coins graduated → no escrow).
    function _assertInvariant(Token[] memory ts) internal view {
        uint256 qSum;
        for (uint256 i; i < ts.length; i++) {
            (uint256 bt, uint256 bq) = _bucket(ts[i]);
            assertEq(ts[i].balanceOf(address(lockedLP)), bt, "token bucket == balance");
            qSum += bq;
            assertEq(_liq(ts[i]), _v4Liq(ts[i]), "stored liquidity == v4 position");
        }
        assertEq(quote.balanceOf(address(lockedLP)), qSum, "sum quote buckets == balance");
    }

    function _one(Token t) internal pure returns (Token[] memory a) {
        a = new Token[](1);
        a[0] = t;
    }

    function _count(bytes32 topic) internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) n++;
        }
    }

    function _buy(Token t, uint256 q) internal {
        _swapExactInQuoteForToken(t, trader1, q);
    }

    function _sellFrac(Token t, uint256 div) internal {
        _swapExactInTokenForQuote(t, trader1, t.balanceOf(trader1) / div);
    }

    function setUp() public override {
        super.setUp();
        tok = _grad();
    }

    function test_defaults_and_wiring() public view {
        assertEq(lockedLP.hook(), address(hook));
        assertEq(address(hook.compounder()), address(lockedLP));
        assertEq(lockedLP.minCompoundPpm(), 50);
        assertEq(lockedLP.maxCompoundPpm(), 20_000);
        assertEq(lockedLP.maxCompoundDeviationBps(), 300);
        _assertInvariant(_one(tok));
    }

    /// @dev Decision 2026-10-16: unpaired graduation quote seeds the coin's compound quote bucket.
    function test_graduation_leftover_goes_to_quote_bucket() public view {
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertEq(bt, 0);
        assertGt(bq, 0, "leftover quote in bucket");
        assertEq(quote.balanceOf(address(lockedLP)), bq);
        // ~15.6% of the ~$11K raise on the 18-dec mock quote at $1
        assertGt(bq, 1_000 ether);
        assertLt(bq, 3_000 ether);
    }

    /// @dev The leftover quote pairs over time with incoming buy-side token fees, at default params.
    function test_leftover_pairs_over_time_with_token_fees_defaults() public {
        (, uint256 bq0) = _bucket(tok);
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        uint256 adds;
        // small buys (each moves price < the 3% deviation guard at graduation depth)
        for (uint256 i; i < 20; i++) {
            _buy(tok, 50 ether);
            adds += _count(COMPOUNDED);
            vm.recordLogs();
            _assertInvariant(_one(tok));
        }
        assertGt(adds, 0, "token fees compounded against leftover quote");
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertLt(bq, bq0, "leftover quote being consumed");
        assertGt(_liq(tok), l0);
        assertLt(bt, 50_000_000 ether, "token side not piling up");
    }

    function test_buy_then_sell_pairing() public {
        // accumulate a buy's token fee without adding, then a sell (quote fee) triggers the add
        _params(1_000_000, 0, 5000);
        _buy(tok, 200 ether);
        (uint256 bt,) = _bucket(tok);
        assertGt(bt, 1);
        _params(1, 0, 5000);
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _sellFrac(tok, 2);
        assertEq(_count(COMPOUNDED), 1, "paired: add");
        assertGt(_liq(tok), l0);
        (uint256 bt2,) = _bucket(tok);
        assertLt(bt2, bt / 1e9, "token (scarce side) used up to < 1 liquidity unit, quote carries");
        _assertInvariant(_one(tok));
    }

    function test_one_sided_accumulation_then_pairing() public {
        _params(1, 0, 5000);
        _buy(tok, 50 ether); // pairs against the leftover → token side exhausted (dust < 1 liquidity unit)
        (uint256 bt,) = _bucket(tok);
        assertLt(bt, 1e6);
        vm.recordLogs();
        for (uint256 i; i < 4; i++) _sellFrac(tok, 10); // quote-only fees: one-sided, no add
        assertEq(_count(COMPOUNDED), 0);
        (, uint256 bq) = _bucket(tok);
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _buy(tok, 50 ether);
        assertEq(_count(COMPOUNDED), 1);
        (uint256 bt2, uint256 bq2) = _bucket(tok);
        assertLt(bt2, 1e6);
        assertLt(bq2, bq);
        assertGt(_liq(tok), l0);
        _assertInvariant(_one(tok));
    }

    function test_threshold_skip() public {
        _params(1_000_000, 0, 5000); // need L >= 100% of position: never in normal trading
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        assertEq(_count(COMPOUNDED), 0);
        assertEq(_liq(tok), l0);
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertGt(bt, 0);
        assertGt(bq, 0);
        _assertInvariant(_one(tok));
    }

    function test_cap_limits_each_add() public {
        _params(1_000_000, 0, 5000);
        _buy(tok, 500 ether); // accumulate token side
        _params(1, 2, 5000); // cap = 2 ppm of position liquidity
        uint128 l0 = _liq(tok);
        _sellFrac(tok, 2);
        uint128 added = _liq(tok) - l0;
        assertEq(added, uint128(uint256(l0) * 2 / 1e6), "added == cap");
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertGt(bt, 1);
        assertGt(bq, 1, "both sides carry when capped");
        _assertInvariant(_one(tok));
    }

    function test_deviation_skip_and_sandwich() public {
        _params(1_000_000, 0, 100);
        _buy(tok, 200 ether); // build token bucket without adding
        _params(1, 0, 100); // 1% max deviation
        // big sell moves the price >1% → afterSwap must skip even though buckets now pair
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _sellFrac(tok, 1);
        assertEq(_count(COMPOUNDED), 0, "price moved > maxDeviation: skipped");
        assertEq(_liq(tok), l0);
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertGt(bt, 0);
        assertGt(bq, 0);
        // a small trade right after (price barely moves) does compound → the skip was the deviation guard
        vm.recordLogs();
        _buy(tok, 1 ether);
        assertEq(_count(COMPOUNDED), 1);
        l0 = _liq(tok);
        _params(1_000_000, 0, 100);
        _buy(tok, 200 ether); // refill token side for the flush attempt

        // atomic sandwich around flush: flush refuses in a tx that already swapped this pool
        _params(1, 0, 5000);
        Sandwicher sw = new Sandwicher();
        quote.mint(address(sw), 5_000 ether);
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        // disable in-swap compounding so only flush could add during the sandwich
        hook.setCompounder(address(0), 250_000);
        bool reverted =
            sw.run(swapRouter, _poolKey(tok), lockedLP, address(tok), quote, IERC20(address(tok)), !tokenIsC0);
        assertTrue(reverted, "flush reverted (SwappedInTx)");
        assertEq(_liq(tok), l0);
        hook.setCompounder(address(lockedLP), 250_000);
        _assertInvariant(_one(tok));
    }

    function test_add_failure_never_reverts_swap() public {
        _params(1_000_000, 0, 5000);
        _buy(tok, 200 ether);
        _params(1, 0, 5000);
        // make the add revert: LockedLP no longer allowlisted → beforeAddLiquidity reverts inside modifyLiquidity
        hook.setLiquidityManager(address(lockedLP), false);
        uint128 l0 = _liq(tok);
        (uint256 bt0,) = _bucket(tok);
        uint256 qBefore = quote.balanceOf(trader1);
        vm.recordLogs();
        _sellFrac(tok, 2); // must succeed
        assertEq(_count(FAILED), 1, "CompoundFailed emitted");
        assertGt(quote.balanceOf(trader1), qBefore, "swap went through");
        assertEq(_liq(tok), l0);
        (uint256 bt1, uint256 bq1) = _bucket(tok);
        assertEq(bt1, bt0, "token bucket untouched");
        assertGt(bq1, 0, "quote fee still bucketed");
        _assertInvariant(_one(tok));

        // re-enable: next trade compounds the carried buckets
        hook.setLiquidityManager(address(lockedLP), true);
        vm.recordLogs();
        _buy(tok, 10 ether);
        assertEq(_count(COMPOUNDED), 1);
        _assertInvariant(_one(tok));
    }

    function test_reverting_compounder_never_reverts_swap() public {
        RevertingCompounder rc = new RevertingCompounder();
        hook.setCompounder(address(rc), 250_000);
        vm.recordLogs();
        _buy(tok, 10 ether);
        assertEq(_count(FAILED), 1);
        GasBurner gb = new GasBurner();
        hook.setCompounder(address(gb), 1_000_000); // burns all forwarded gas
        _buy(tok, 10 ether);
    }

    function test_only_hook_can_compound_in_swap() public {
        vm.expectRevert(LockedLP.OnlyHook.selector);
        lockedLP.compoundFromHook(address(tok), 1);
    }

    function test_flush_permissionless() public {
        _params(1_000_000, 0, 5000);
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        uint128 l0 = _liq(tok);
        // below threshold: flush is a no-op (returns 0)
        vm.prank(trader2);
        assertEq(lockedLP.flush(address(tok)), 0);
        _params(1, 0, 5000);
        vm.prank(trader2);
        uint128 added = lockedLP.flush(address(tok));
        assertGt(added, 0);
        assertEq(_liq(tok), l0 + added);
        _assertInvariant(_one(tok));
        // nothing left to pair → 0
        vm.prank(trader2);
        assertEq(lockedLP.flush(address(tok)), 0);
    }

    function test_flush_requires_graduated() public {
        (, Token t2) = _launch(0, 0);
        vm.expectRevert(LockedLP.NotGraduated.selector);
        lockedLP.flush(address(t2));
    }

    function test_multi_coin_isolation() public {
        tokB = _grad();
        _params(1_000_000, 0, 5000); // accumulate only
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        (uint256 bBt, uint256 bBq) = _bucket(tokB);
        uint128 lB = _liq(tokB);
        Token[] memory both = new Token[](2);
        both[0] = tok;
        both[1] = tokB;
        _assertInvariant(both);

        // trade B too, then compound A only via flush — B untouched
        _swapExactInQuoteForToken(tokB, trader2, 100 ether);
        (bBt, bBq) = _bucket(tokB);
        _params(1, 0, 5000);
        lockedLP.flush(address(tok));
        (uint256 bBt2, uint256 bBq2) = _bucket(tokB);
        assertEq(bBt2, bBt);
        assertEq(bBq2, bBq);
        assertEq(_liq(tokB), lB);
        _assertInvariant(both);
    }

    function test_params_guarded() public {
        vm.expectRevert(LockedLP.OnlyOwner.selector);
        lockedLP.setCompoundParams(1, 0, 100);
        vm.startPrank(owner);
        vm.expectRevert(LockedLP.BadParams.selector);
        lockedLP.setCompoundParams(10, 5, 100);
        vm.expectRevert(LockedLP.BadParams.selector);
        lockedLP.setCompoundParams(1, 0, 0);
        vm.stopPrank();
    }

    function testFuzz_trades_keep_invariant(uint256 seed) public {
        _params(1, 50_000, 5000);
        for (uint256 i; i < 8; i++) {
            seed = uint256(keccak256(abi.encode(seed)));
            if (seed % 2 == 0 || tok.balanceOf(trader1) < 1e18) _buy(tok, 1 ether + seed % 300 ether);
            else _sellFrac(tok, 2 + seed % 10);
            _assertInvariant(_one(tok));
        }
    }
}

contract RevertingCompounder {
    function compoundFromHook(address, uint160) external pure returns (uint128) {
        revert("nope");
    }
}

contract GasBurner {
    function compoundFromHook(address, uint160) external pure returns (uint128) {
        while (true) {}
        return 0;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Atomic sandwich: swap, flush, swap back — all in one tx.
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

    Token tok;
    Token tokB;

    function _grad() internal returns (Token t) {
        (BondingCurve c, Token t_) = _launch(0, 0);
        _graduate(c);
        t = t_;
    }

    function _params(uint32 minPpm, uint32 maxPpm, uint16) internal {
        vm.prank(owner);
        lockedLP.setCompoundParams(minPpm, maxPpm);
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
        assertEq(lockedLP.minCompoundPpm(), 1_000);
        assertEq(lockedLP.maxCompoundPpm(), 5_000);
        _assertInvariant(_one(tok));
    }

    /// @dev Decision 2026-10-16: unpaired graduation quote seeds the coin's compound quote bucket.
    function test_graduation_leftover_goes_to_quote_bucket() public view {
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertEq(bt, 0, "no token fees yet");
        assertGt(bq, 0, "leftover quote in bucket");
        assertEq(quote.balanceOf(address(lockedLP)), bq);
        // phase 3a: the ~$1.2K curve leftover seeds the 16-band floor; the bucket keeps only the curve-phase fee
        // LP escrow (+ sniper escrow, if any) + floor rounding dust
        (,, uint128 seeded) = lockedLP.floorInfo(address(tok));
        assertApproxEqAbs(seeded, 1_201.27 ether, 1 ether, "leftover -> floor");
        assertLt(bq, 100 ether, "bucket = escrows + dust only");
    }

    /// @dev The leftover quote pairs over time with incoming buy-side token fees, at default params (keeper flushes
    ///      once a minute).
    function test_leftover_pairs_over_time_with_token_fees_defaults() public {
        (, uint256 bq0) = _bucket(tok);
        uint128 l0 = _liq(tok);
        uint256 adds;
        for (uint256 i; i < 100; i++) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 60);
            _buy(tok, 25 ether);
            vm.recordLogs();
            _flush(address(tok));
            adds += _count(COMPOUNDED);
            _assertInvariant(_one(tok));
        }
        assertGt(adds, 0, "token fees compounded against leftover quote");
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertLt(bq, bq0, "leftover quote being consumed");
        assertGt(_liq(tok), l0);
        assertLt(bt, 50_000_000 ether, "token side not piling up");
    }

    function test_swaps_only_bucket() public {
        _params(1, 0, 5000);
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        assertEq(_count(COMPOUNDED), 0, "no add inside a swap");
        assertEq(_liq(tok), l0);
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertGt(bt, 1);
        assertGt(bq, 1);
        _assertInvariant(_one(tok));
    }

    function test_buy_then_sell_pairing() public {
        _buy(tok, 200 ether);
        (uint256 bt,) = _bucket(tok);
        assertGt(bt, 1);
        _sellFrac(tok, 2);
        _params(1, 0, 5000);
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _flush(address(tok));
        assertEq(_count(COMPOUNDED), 1, "paired: add");
        assertGt(_liq(tok), l0);
        _assertInvariant(_one(tok));
    }

    function test_one_sided_accumulation_then_pairing() public {
        _params(1, 0, 5000);
        _buy(tok, 50 ether);
        _flush(address(tok)); // pairs against the leftover → token side exhausted (dust < 1 liquidity unit)
        (uint256 bt,) = _bucket(tok);
        assertLt(bt, 1e6);
        for (uint256 i; i < 4; i++) _sellFrac(tok, 10); // quote-only fees
        vm.roll(vm.getBlockNumber() + 1);
        vm.recordLogs();
        _flush(address(tok));
        assertEq(_count(COMPOUNDED), 0, "one-sided: nothing to pair");
        (, uint256 bq) = _bucket(tok);
        uint128 l0 = _liq(tok);
        _buy(tok, 50 ether);
        vm.recordLogs();
        _flush(address(tok));
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
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        assertEq(_flush(address(tok)), 0);
        assertEq(_liq(tok), l0);
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertGt(bt, 0);
        assertGt(bq, 0);
        _assertInvariant(_one(tok));
    }

    function test_cap_limits_each_add() public {
        _buy(tok, 500 ether);
        _sellFrac(tok, 2);
        _params(1, 2, 5000); // cap = 2 ppm of position liquidity
        uint128 l0 = _liq(tok);
        uint128 added = _flush(address(tok));
        assertEq(added, uint128(uint256(l0) * 2 / 1e6), "added == cap");
        (uint256 bt, uint256 bq) = _bucket(tok);
        assertGt(bt, 1);
        assertGt(bq, 1, "both sides carry when capped");
        _assertInvariant(_one(tok));
    }

    /// An atomic sandwich around flush adds at most the per-window cap (0.5% of liquidity).
    function test_sandwiched_flush_is_capped() public {
        _buy(tok, 2_000 ether);
        _sellFrac(tok, 2);
        _params(1, 5_000, 0);
        uint128 l0 = _liq(tok);
        Sandwicher sw = new Sandwicher();
        quote.mint(address(sw), 5_000 ether);
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        vm.roll(vm.getBlockNumber() + 1);
        bool reverted =
            sw.run(swapRouter, _poolKey(tok), lockedLP, address(tok), quote, IERC20(address(tok)), !tokenIsC0);
        assertFalse(reverted);
        assertLe(uint256(_liq(tok) - l0) * 1e6, uint256(l0) * 5_000 + l0, "<= 0.5% of L");
        _assertInvariant(_one(tok));
    }

    function test_flush_permissionless() public {
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        _params(1, 0, 0);
        uint128 l0 = _liq(tok);
        vm.prank(trader2);
        uint128 added = lockedLP.flush(address(tok));
        assertGt(added, 0);
        assertEq(_liq(tok), l0 + added);
        _assertInvariant(_one(tok));
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(trader2);
        assertEq(lockedLP.flush(address(tok)), 0, "nothing left to pair");
    }

    function test_flush_requires_graduated() public {
        (, Token t2) = _launch(0, 0);
        vm.expectRevert(LockedLP.NotGraduated.selector);
        lockedLP.flush(address(t2));
    }

    function test_multi_coin_isolation() public {
        tokB = _grad();
        _buy(tok, 200 ether);
        _sellFrac(tok, 2);
        _swapExactInQuoteForToken(tokB, trader2, 100 ether);
        (uint256 bBt, uint256 bBq) = _bucket(tokB);
        uint128 lB = _liq(tokB);
        Token[] memory both = new Token[](2);
        both[0] = tok;
        both[1] = tokB;
        _assertInvariant(both);
        _params(1, 0, 5000);
        _flush(address(tok));
        (uint256 bBt2, uint256 bBq2) = _bucket(tokB);
        assertEq(bBt2, bBt);
        assertEq(bBq2, bBq);
        assertEq(_liq(tokB), lB);
        _assertInvariant(both);
    }

    function test_params_guarded() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        lockedLP.setCompoundParams(1, 0);
        vm.startPrank(owner);
        vm.expectRevert(LockedLP.BadParams.selector);
        lockedLP.setCompoundParams(10, 5);
        vm.expectRevert(LockedLP.BadParams.selector);
        lockedLP.setCompoundParams(1e6 + 1, 0);
        vm.stopPrank();
    }

    function testFuzz_trades_keep_invariant(uint256 seed) public {
        _params(1, 50_000, 5000);
        for (uint256 i; i < 8; i++) {
            seed = uint256(keccak256(abi.encode(seed)));
            if (seed % 2 == 0 || tok.balanceOf(trader1) < 1e18) _buy(tok, 1 ether + seed % 300 ether);
            else _sellFrac(tok, 2 + seed % 10);
            if (seed % 3 == 0) {
                vm.roll(vm.getBlockNumber() + 1);
                _flush(address(tok));
            }
            _assertInvariant(_one(tok));
        }
    }
}

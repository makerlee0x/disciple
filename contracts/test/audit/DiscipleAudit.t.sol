// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {IReferralRegistry} from "../../src/interfaces/IReferralRegistry.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// @dev Audit #2 PoC: pre-pays (sync → transfer) BEFORE swapping, settles after. A compound inside the swap that
///      calls sync() would wipe this pending sync and make the final settle() credit 0 → CurrencyNotSettled.
contract PrepaySwapper is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(PoolKey memory key, bool zfo, uint256 amt) external {
        pm.unlock(abi.encode(key, zfo, amt));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (PoolKey memory key, bool zfo, uint256 amt) = abi.decode(raw, (PoolKey, bool, uint256));
        Currency cin = zfo ? key.currency0 : key.currency1;
        Currency cout = zfo ? key.currency1 : key.currency0;
        pm.sync(cin);
        IERC20(Currency.unwrap(cin)).transfer(address(pm), amt);
        BalanceDelta d = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zfo,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        pm.settle();
        int128 o = zfo ? d.amount1() : d.amount0();
        pm.take(cout, address(this), uint256(uint128(o)));
        return "";
    }
}

contract DiscipleAuditTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    bytes32 constant COMPOUNDED = keccak256("LiquidityCompounded(address,uint128,uint256,uint256,uint256,uint256)");

    function _count(bytes32 topic) internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) n++;
        }
    }

    function _gradReady() internal returns (Token tok) {
        BondingCurve c;
        (c, tok) = _launch(0, 0);
        _graduate(c);
        // token-side fees + leftover quote → both buckets. The swap runs under the default min (no compound yet):
        // the steep curve leaves ~$1.2K leftover quote, so a tiny-min compound here would drain the token bucket.
        vm.prank(owner);
        lockedLP.setCompoundParams(1_000, 5_000); // defaults (a looped test may have changed them)
        _swapExactInQuoteForToken(tok, trader1, 50 ether);
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 0); // tiny min, uncapped, 3% guard
        (uint256 bt, uint256 bq) = lockedLP.compoundBucket(address(tok));
        require(bt >= 2 && bq >= 2, "buckets");
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _spot(Token t) internal view returns (uint160 sp) {
        (sp,,,) = manager.getSlot0(_poolKey(t).toId());
    }

    function _liq(Token t) internal view returns (uint128 l) {
        (,,,,,, l) = lockedLP.positions(address(t));
    }

    // ── Slim hook (2026-11-17): the hook never compounds; LockedLP.flush is keeper-only at a reference price ──

    /// Swaps only bucket the LP share. The hook makes no call into LockedLP and the position never grows on a swap.
    function test_swapsNeverCompound() public {
        Token tok = _gradReady();
        uint128 l0 = _liq(tok);
        vm.expectCall(address(lockedLP), abi.encodeWithSelector(LockedLP.flush.selector), 0);
        vm.recordLogs();
        for (uint256 i; i < 5; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            _swapExactInQuoteForToken(tok, trader1, 20 ether);
            _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1));
        }
        assertEq(_count(COMPOUNDED), 0, "no compound inside swaps");
        assertEq(_liq(tok), l0);
    }

    /// maker 2026-11-17: flush is permissionless (no sandwiching on Robinhood's FCFS sequencer).
    function test_flush_permissionless() public {
        Token tok = _gradReady();
        vm.prank(makeAddr("anyone"));
        assertGt(lockedLP.flush(address(tok)), 0);
    }

    function test_flush_compoundsAtSpot() public {
        Token tok = _gradReady();
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        uint128 added = _flush(address(tok));
        assertGt(added, 0);
        assertEq(_count(COMPOUNDED), 1);
        assertEq(_liq(tok), l0 + added);
    }

    /// High-1 (self-sandwich): pump → flush (adds at the pumped price) → dump in one block. The add is capped at
    /// maxCompoundPpm of liquidity and the attacker pays the 1% fee both ways, so it ends no better than with
    /// compounding off.
    function _pumpFlushDump(Token tok, uint256 pump) internal returns (uint256 endQuote, uint256 n) {
        address att = makeAddr("xatk");
        uint256 b0 = quote.balanceOf(att);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, att, pump);
        lockedLP.flush(address(tok));
        _swapExactInTokenForQuote(tok, att, tok.balanceOf(att));
        n = _count(COMPOUNDED);
        endQuote = quote.balanceOf(att) - b0;
    }

    function test_high1_selfSandwichFlush_unprofitable() public {
        uint256[3] memory pumps = [uint256(5_000 ether), 20_000 ether, 60_000 ether];
        for (uint256 i; i < pumps.length; ++i) {
            uint256 snap0 = vm.snapshotState();
            Token tok = _gradReady();
            vm.prank(owner);
            lockedLP.setCompoundParams(1, 5_000); // defaults' 0.5% cap, tiny min
            uint256 snap = vm.snapshotState();
            (uint256 atk,) = _pumpFlushDump(tok, pumps[i]);
            vm.revertToState(snap);
            vm.prank(owner);
            lockedLP.setCompoundParams(1_000_000, 0); // control: compounding off
            (uint256 ctl,) = _pumpFlushDump(tok, pumps[i]);
            console2.log("pump / attacker / control", pumps[i] / 1e18, atk, ctl);
            // Open flush (maker 2026-11-17): a self-sandwich can make the add land at a pumped price, but the round trip
            // still loses money (2% of fees each way dwarfs it), and what the flush shifts is capped by the budget.
            assertLt(atk, pumps[i], "the pump-flush-dump round trip loses money");
            assertLe(atk, ctl + ctl / 200, "a flush shifts < 0.5% of the round trip");
            vm.revertToState(snap0);
        }
    }

    /// Budget: one add per block, and at most maxCompoundPpm (0.5%) of liquidity per 60 s window.
    function test_flush_budget() public {
        Token tok = _gradReady();
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 5_000);
        address v = makeAddr("volume");
        for (uint256 i; i < 6; i++) {
            _swapExactInQuoteForToken(tok, v, 5_000 ether);
            _swapExactInTokenForQuote(tok, v, tok.balanceOf(v));
        }
        // the volume's fees moved the price; let the flush reference tick catch up (REF_TICKS_PER_MIN)
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.roll(vm.getBlockNumber() + 1);
        uint128 l0 = _liq(tok);
        assertGt(_flush(address(tok)), 0);
        assertEq(_flush(address(tok)), 0, "<= one add per block");
        for (uint256 i; i < 10; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 1);
            _flush(address(tok));
        }
        (uint32 ws, uint24 used,) = lockedLP.compoundBudget(address(tok));
        assertLe(uint256(_liq(tok) - l0) * 1e6, uint256(l0) * 5_000 + l0, "<= 0.5% of L per 60 s window");
        assertLe(used, 5_000 + 1);
        vm.warp(vm.getBlockTimestamp() + 60);
        vm.roll(vm.getBlockNumber() + 1);
        (uint256 bt, uint256 bq) = lockedLP.compoundBucket(address(tok));
        if (bt >= 2 && bq >= 2) {
            _flush(address(tok));
            (uint32 ws2,,) = lockedLP.compoundBudget(address(tok));
            assertGt(ws2, ws, "new window");
        }
    }

    /// #2 LOW: a swapper's pending sync (pre-paid input) is untouched by the hook (it never syncs).
    function test_audit2_pendingSyncNotOverwritten() public {
        Token tok = _gradReady();
        PrepaySwapper p = new PrepaySwapper(manager);
        quote.mint(address(p), 10 ether);
        bool zfoBuy = uint160(address(tok)) > uint160(address(quote));
        p.run(_poolKey(tok), zfoBuy, 5 ether);
        assertGt(tok.balanceOf(address(p)), 0);
    }

    /// #4 MEDIUM: pre-grad sellToUsdg books NET position, fee referral and Trade to the trader, not the router.
    function test_audit4_routerSellAttributesTrader() public {
        address alice = makeAddr("aliceA4");
        _bindReferral(alice, kol, 10 ether);
        router.setUsdgRouting(address(quote), address(launchpad));
        (BondingCurve c, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        quote.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        quote.approve(address(router), type(uint256).max);
        tok.approve(address(router), type(uint256).max);
        uint256 out = router.buyWithUsdg(address(tok), 100 ether, 1, block.timestamp + 1);
        // lp-accrue: a referred trader's fee settles in the same trade, to CurveFeeVault (exact 1% attribution)
        uint256 r0 = feeVault.referrerAccrued(kol, address(quote));
        vm.recordLogs();
        router.sellToUsdg(address(tok), out, 1, block.timestamp + 1);
        vm.stopPrank();
        assertGt(feeVault.referrerAccrued(kol, address(quote)), r0, "trader's referrer paid on the sell");
        assertEq(c.balanceOnCurve(alice), 0);
        assertEq(c.balanceOnCurve(address(router)), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 tradeTopic = keccak256(
            "Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
        );
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(c) && logs[i].topics[0] == tradeTopic) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice, "Trade.trader = real trader");
                seen = true;
            }
        }
        assertTrue(seen);
    }

    /// #8 LOW: the graduating buy charges (to 1e-12) the minimum quote that buys the remaining supply.
    /// L4: graduating refund is minimal across creator taxes, quote sizes up to 1e33 and the anti-snipe window
    ///     (fees on a different base), checked against the exact property rather than the old 8-step loop's luck.
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_audit8_refundMinimal(uint256 taxSeed, uint256 inSeed, bool inSnipe) public {
        uint256 tax = bound(taxSeed, 0, Constants.CREATOR_TAX_MAX_BPS);
        (BondingCurve c,) = _launch(tax, 0);
        if (!inSnipe) _warpPastSnipe();
        for (uint256 i; i < 40 && c.progressBps() < 9000; ++i) {
            address w = makeAddr(string(abi.encodePacked("f8", vm.toString(i))));
            quote.mint(w, 1_000 ether);
            vm.startPrank(w);
            quote.approve(address(c), 1_000 ether);
            c.buy(400 ether, 0, vm.getBlockTimestamp() + 1);
            vm.stopPrank();
        }
        (, uint256 sc,,) = c.curveParams();
        uint256 remaining = sc - c.tokensSold();
        // lower bound must over-pay even at max creator tax + max anti-snipe fee
        uint256 quoteIn = bound(inSeed, 1e25, 1e33);
        BondingCurve.BuyQuote memory q = c.quoteBuy(quoteIn);
        assertEq(q.tokensOut, remaining);
        uint256 used = quoteIn - q.refund;
        assertGt(q.refund, 0, "refund on every overpaying graduating buy");
        assertEq(c.quoteBuy(used).tokensOut, remaining, "used buys all");
        assertLt(c.quoteBuy(used - used / 1e11 - 1).tokensOut, remaining, "no material overcharge");
    }

    function test_audit8_graduatingRefundMinimal() public {
        (BondingCurve c,) = _launch(100, 0);
        _warpPastSnipe();
        for (uint256 i; i < 40 && c.progressBps() < 9000; ++i) {
            address w = makeAddr(string(abi.encodePacked("a8", vm.toString(i))));
            quote.mint(w, 1_000 ether);
            vm.startPrank(w);
            quote.approve(address(c), 1_000 ether);
            c.buy(400 ether, 0, block.timestamp + 1);
            vm.stopPrank();
        }
        (, uint256 sc,,) = c.curveParams();
        uint256 remaining = sc - c.tokensSold();
        uint256[4] memory ins = [uint256(5_000 ether), 77_777 ether, 1e27, 1e33];
        for (uint256 k; k < 4; ++k) {
            BondingCurve.BuyQuote memory q = c.quoteBuy(ins[k]);
            assertEq(q.tokensOut, remaining);
            uint256 used = ins[k] - q.refund;
            assertGt(q.refund, 0);
            assertEq(c.quoteBuy(used).tokensOut, remaining, "used buys all");
            uint256 less = used - used / 1e11 - 1;
            assertLt(c.quoteBuy(less).tokensOut, remaining, "no material overcharge");
        }
    }
}

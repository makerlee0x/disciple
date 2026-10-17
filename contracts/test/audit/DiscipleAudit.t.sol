// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {UsdgDepositNotifier} from "../../src/UsdgDepositNotifier.sol";
import {IReferralRegistry} from "../../src/interfaces/IReferralRegistry.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// @dev Audit #1 PoC: pump → dust swap (would compound at the pumped price) → dump, all in ONE tx.
contract PumpDustDump {
    function run(PoolSwapTest r, PoolKey memory key, IERC20 quote, IERC20 tok, bool zfoBuy, uint256 pump) external {
        quote.approve(address(r), type(uint256).max);
        tok.approve(address(r), type(uint256).max);
        _swap(r, key, zfoBuy, pump);
        _swap(r, key, zfoBuy, 1e15); // dust: its own before/after prices are within 3%
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
        _warpRefReady(); // compound reference needs 60 s of history
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 0, 300); // tiny min, uncapped, 3% guard
        _swapExactInQuoteForToken(tok, trader1, 50 ether); // token-side fees + leftover quote → both buckets
        (uint256 bt, uint256 bq) = lockedLP.compoundBucket(address(tok));
        require(bt >= 2 && bq >= 2, "buckets");
        vm.roll(vm.getBlockNumber() + 1); // later trades are in a fresh block (block-start anchor)
    }

    /// #1 HIGH: no compounding at a price manipulated earlier in the same tx.
    function test_audit1_noCompoundAfterSameTxPump() public {
        Token tok = _gradReady();
        // sanity: an honest dust swap in its own tx compounds
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 20 ether);
        assertEq(_count(COMPOUNDED), 1, "honest swap compounds");
        _swapExactInQuoteForToken(tok, trader1, 20 ether); // refill token side
        PumpDustDump a = new PumpDustDump();
        quote.mint(address(a), 20_000 ether);
        bool zfoBuy = uint160(address(tok)) > uint160(address(quote)); // quote is c0 → buy = zeroForOne
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        a.run(swapRouter, _poolKey(tok), IERC20(address(quote)), IERC20(address(tok)), zfoBuy, 10_000 ether);
        assertEq(_count(COMPOUNDED), 0, "no compound inside the sandwich");
        assertEq(_liq(tok), l0);
    }

    /// Follow-up: pump (tx1) → dust swap (tx2) → dump (tx3), all in the SAME block: the dust swap must not compound.
    function test_sameBlockMultiTxPumpDustDump_skipped() public {
        Token tok = _gradReady();
        vm.roll(vm.getBlockNumber() + 1);
        _swapExactInQuoteForToken(tok, trader1, 20 ether); // refill token side (own block)
        vm.roll(vm.getBlockNumber() + 1);
        uint128 l0 = _liq(tok);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader2, 10_000 ether); // tx1 pump (>3% → its own swap skips)
        // separate tx: the per-tx flags are clear, so only the block-start anchor can stop the dust compound
        PoolId pid = _poolKey(tok).toId();
        assertFalse(hook.swappedInTx(pid), "tx1 flags cleared");
        (uint64 ab,) = hook.blockAnchor(pid);
        assertEq(ab, uint64(vm.getBlockNumber()), "anchor = this block");
        _swapExactInQuoteForToken(tok, trader1, 1e15); // tx2 dust: within 3% of its own pre-price
        _swapExactInTokenForQuote(tok, trader2, tok.balanceOf(trader2)); // tx3 dump
        assertEq(_count(COMPOUNDED), 0, "no compound against the block-start price");
        assertEq(_liq(tok), l0);
        // next block, honest swap compounds again
        vm.roll(vm.getBlockNumber() + 1);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 20 ether);
        assertEq(_count(COMPOUNDED), 1, "honest swap in a fresh block compounds");
    }

    /// Follow-up: a permissionless flush after a same-block pump (separate tx) compounds nothing.
    function test_sameBlockPumpThenFlush_skipped() public {
        Token tok = _gradReady();
        vm.roll(vm.getBlockNumber() + 1);
        _swapExactInQuoteForToken(tok, trader1, 20 ether);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(owner);
        lockedLP.setCompoundParams(1_000_000, 0, 300); // block in-swap compounding (min 100%), keep the buckets
        _swapExactInQuoteForToken(tok, trader2, 10_000 ether); // tx1 pump
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 0, 300);
        assertEq(lockedLP.flush(address(tok)), 0, "flush vs block-start price: skipped");
        vm.roll(vm.getBlockNumber() + 1); // new block, no swap yet: flush still checks the EMA reference
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(lockedLP.flush(address(tok)), 0, "cross-block flush vs EMA: skipped (High-1)");
    }

    // ── High-1: cross-block pump (last swap of block N) → dust swap / flush in N+1 → dump ──

    /// @dev Fills both LP buckets with real fee volume (no adds), then restores the default params (0.5% cap).
    function _bigBuckets(Token tok) internal {
        vm.prank(owner);
        lockedLP.setCompoundParams(1_000_000, 0, 300); // accumulate only
        address v = makeAddr("volume");
        for (uint256 i; i < 6; i++) {
            _swapExactInQuoteForToken(tok, v, 5_000 ether);
            _swapExactInTokenForQuote(tok, v, tok.balanceOf(v));
        }
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 5_000, 300); // defaults: 0.5% cap, 3% guard
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 61); // EMA settles back at the post-volume price
        _swapExactInQuoteForToken(tok, v, 1e15);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1);
    }

    function _xblock(Token tok, uint256 pump, uint256 holdSecs, bool viaFlush)
        internal
        returns (uint256 endQuote, uint256 nComp)
    {
        address att = makeAddr("xatk");
        uint256 b0 = quote.balanceOf(att);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, att, pump); // block N, last swap
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + holdSecs);
        if (viaFlush) lockedLP.flush(address(tok));
        else _swapExactInQuoteForToken(tok, att, 1e15); // dust in N+1
        _swapExactInTokenForQuote(tok, att, tok.balanceOf(att)); // dump
        nComp = _count(COMPOUNDED);
        endQuote = quote.balanceOf(att) - b0;
    }

    function _xblockVsControl(uint256 pump, bool viaFlush) internal {
        Token tok = _gradReady();
        _bigBuckets(tok);
        uint256 snap = vm.snapshotState();
        (uint256 atk, uint256 n) = _xblock(tok, pump, 1, viaFlush);
        vm.revertToState(snap);
        vm.prank(owner);
        lockedLP.setCompoundParams(1_000_000, 0, 300); // control: compounding off
        (uint256 ctl,) = _xblock(tok, pump, 1, viaFlush);
        console2.log("pump", pump / 1e18, viaFlush ? 1 : 0);
        console2.log("  attacker end / control end (quote wei)", atk, ctl);
        assertEq(n, 0, "no compound across one block boundary");
        assertLe(atk, ctl, "attacker <= control");
    }

    function test_high1_crossBlockDust_60k() public {
        _xblockVsControl(60_000 ether, false);
    }

    function test_high1_crossBlockDust_80k() public {
        _xblockVsControl(80_000 ether, false);
    }

    function test_high1_crossBlockDust_150k() public {
        _xblockVsControl(150_000 ether, false);
    }

    function test_high1_crossBlockFlush_60k() public {
        _xblockVsControl(60_000 ether, true);
    }

    function test_high1_crossBlockFlush_80k() public {
        _xblockVsControl(80_000 ether, true);
    }

    function test_high1_crossBlockFlush_150k() public {
        _xblockVsControl(150_000 ether, true);
    }

    /// Bounded worst case: the attacker HOLDS the pump for a full EMA window (nobody arbs it back), so the
    /// reference catches up and one capped (0.5%) add happens at the pumped price. Still a net loss.
    function test_high1_heldPumpBoundedUnprofitable() public {
        uint256[3] memory pumps = [uint256(60_000 ether), 80_000 ether, 150_000 ether];
        for (uint256 i; i < 3; i++) {
            Token tok = _gradReady();
            _bigBuckets(tok);
            uint256 spent = pumps[i] + 1e15;
            (uint256 end, uint256 n) = _xblock(tok, pumps[i], 61, false);
            console2.log("held pump", pumps[i] / 1e18, n);
            console2.log("  spent / end (quote wei)", spent, end);
            assertLe(n, 1, "at most one capped add");
            assertLt(end, spent, "held-pump attack is unprofitable");
        }
    }

    /// No reference history yet (just graduated): no compounding at all, flush skips.
    function test_high1_noCompoundBeforeRefAge() public {
        BondingCurve c;
        Token tok;
        (c, tok) = _launch(0, 0);
        _graduate(c);
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 0, 300);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 50 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        assertEq(_count(COMPOUNDED), 0, "reference younger than REF_MIN_AGE");
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(lockedLP.flush(address(tok)), 0);
        (,,, bool ready) = hook.priceReference(_poolKey(tok).toId());
        assertFalse(ready);
        _warpRefReady();
        (,,, ready) = hook.priceReference(_poolKey(tok).toId());
        assertTrue(ready);
    }

    function _liq(Token t) internal view returns (uint128 l) {
        (,,,,,, l) = lockedLP.positions(address(t));
    }

    /// #2 LOW: a swapper's pending sync (pre-paid input) survives the in-swap compound path.
    function test_audit2_pendingSyncNotOverwritten() public {
        Token tok = _gradReady();
        PrepaySwapper p = new PrepaySwapper(manager);
        quote.mint(address(p), 10 ether);
        bool zfoBuy = uint160(address(tok)) > uint160(address(quote));
        p.run(_poolKey(tok), zfoBuy, 5 ether); // would revert CurrencyNotSettled if compound re-synced
        assertGt(tok.balanceOf(address(p)), 0);
    }

    /// #3 GAS: the hook skips the compound call when FeeRouter reports one-sided buckets.
    function test_audit3_hookSkipsCompoundCallWhenNotReady() public {
        Token tok = _gradReady();
        vm.mockCall(
            address(lockedLP), abi.encodeWithSelector(LockedLP.creditLockedLiquidity.selector), abi.encode(false)
        );
        vm.expectCall(address(lockedLP), abi.encodeWithSelector(LockedLP.compoundFromHook.selector), 0);
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
    }

    function test_audit3_hookCallsCompoundWhenReady() public {
        Token tok = _gradReady();
        vm.expectCall(address(lockedLP), abi.encodeWithSelector(LockedLP.compoundFromHook.selector), 1);
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
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
        uint256 r0 = feeRouter.referrerAccrued(kol, address(quote));
        vm.recordLogs();
        router.sellToUsdg(address(tok), out, 1, block.timestamp + 1);
        vm.stopPrank();
        assertGt(feeRouter.referrerAccrued(kol, address(quote)), r0, "trader's referrer paid on the sell");
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

    // ── #7 MEDIUM (follow-up): referral gate needs USDG escrowed + locked 7 days in the notifier ──
    function _notifier() internal returns (ReferralRegistry reg, UsdgDepositNotifier n) {
        reg = new ReferralRegistry(owner);
        n = new UsdgDepositNotifier(owner, IReferralRegistry(address(reg)), IERC20(address(quote)));
        vm.prank(owner);
        reg.setDepositHook(address(n));
    }

    function _ids1(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function test_audit7_honestEscrowPathAndWithdrawAfterLock() public {
        (ReferralRegistry reg, UsdgDepositNotifier n) = _notifier();
        address w = makeAddr("w7");
        uint256 gate = Constants.REFERRAL_USDG_GATE;
        quote.mint(w, gate);
        vm.startPrank(w);
        reg.tryAttribute(w, kol);
        quote.approve(address(n), gate); // exact approve to the notifier
        uint256 id = n.deposit(w, gate); // self-funding is fine: the USDG is locked here
        vm.stopPrank();
        assertEq(reg.referrerOf(w), kol, "gate satisfied");
        assertEq(quote.balanceOf(address(n)), gate, "escrowed in the notifier");
        (uint256 amt, uint256 unlockAt) = n.escrowOf(w, id);
        assertEq(amt, gate);
        assertEq(unlockAt, vm.getBlockTimestamp() + 7 days);
        assertEq(n.escrowedOf(w), gate);
        vm.prank(w);
        vm.expectRevert(abi.encodeWithSelector(UsdgDepositNotifier.Locked.selector, id, unlockAt));
        n.withdraw(_ids1(id));
        vm.warp(unlockAt);
        vm.prank(w);
        n.withdraw(_ids1(id));
        assertEq(quote.balanceOf(w), gate, "withdrawn after lock");
        assertEq(n.escrowedOf(w), 0);
        assertEq(reg.referrerOf(w), kol, "referral stays");
        vm.prank(w);
        vm.expectRevert(UsdgDepositNotifier.NothingEscrowed.selector);
        n.withdraw(_ids1(id));
    }

    /// L5: a third-party gift is its own entry — it never re-locks the beneficiary's existing escrow.
    function test_audit7_giftDoesNotRelockExisting() public {
        (, UsdgDepositNotifier n) = _notifier();
        address w = makeAddr("w7b");
        address g = makeAddr("gifter");
        uint256 gate = Constants.REFERRAL_USDG_GATE;
        quote.mint(w, gate);
        quote.mint(g, gate);
        vm.startPrank(w);
        quote.approve(address(n), gate);
        uint256 id0 = n.deposit(w, gate);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 6 days);
        vm.startPrank(g);
        quote.approve(address(n), gate);
        uint256 id1 = n.deposit(w, gate); // gift on day 6
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days); // day 7: own deposit unlocked, gift still locked
        vm.prank(w);
        n.withdraw(_ids1(id0));
        assertEq(quote.balanceOf(w), gate, "own escrow withdrawable on schedule");
        vm.prank(w);
        vm.expectRevert();
        n.withdraw(_ids1(id1));
        assertEq(n.escrowedOf(w), gate);
    }

    function test_audit7_cyclingSameUsdgFails() public {
        (ReferralRegistry reg, UsdgDepositNotifier n) = _notifier();
        uint256 gate = Constants.REFERRAL_USDG_GATE;
        address a = makeAddr("cycA");
        address b = makeAddr("cycB");
        address c = makeAddr("cycC");
        quote.mint(a, gate); // only $10 in total
        vm.prank(b);
        reg.tryAttribute(b, kol);
        vm.prank(c);
        reg.tryAttribute(c, kol);
        vm.startPrank(a);
        quote.approve(address(n), type(uint256).max);
        n.deposit(b, gate);
        vm.expectRevert(); // a has nothing left: the $10 is locked for b
        n.deposit(c, gate);
        vm.stopPrank();
        // b can't pull it back out to recycle it
        vm.prank(b);
        vm.expectRevert();
        n.withdraw(_ids1(0));
        assertEq(reg.referrerOf(b), kol);
        assertEq(reg.referrerOf(c), address(0), "same USDG can't satisfy the gate twice at once");
        assertEq(reg.usdgDeposited(c), 0);
        // below the $10 minimum (lock-extension griefing costs $10/week)
        quote.mint(a, 1 ether);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(UsdgDepositNotifier.BelowMinimum.selector, gate));
        n.deposit(c, 1 ether);
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
        uint256 quoteIn = bound(inSeed, 10_000 ether, 1e33);
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

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
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

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
        vm.prank(owner);
        lockedLP.setCompoundParams(1, 0, 300); // tiny min, uncapped, 3% guard
        _swapExactInQuoteForToken(tok, trader1, 50 ether); // token-side fees + leftover quote → both buckets
        (uint256 bt, uint256 bq) = lockedLP.compoundBucket(address(tok));
        require(bt >= 2 && bq >= 2, "buckets");
    }

    /// #1 HIGH: no compounding at a price manipulated earlier in the same tx.
    function test_audit1_noCompoundAfterSameTxPump() public {
        Token tok = _gradReady();
        // sanity: an honest dust swap in its own tx compounds
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 1 ether);
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
        vm.clearMockedCalls();
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

    /// #7 MEDIUM: self-deposits can't fake the $10 referral gate.
    function test_audit7_selfDepositRejected() public {
        ReferralRegistry reg = new ReferralRegistry(owner);
        UsdgDepositNotifier n = new UsdgDepositNotifier(owner, IReferralRegistry(address(reg)), IERC20(address(quote)));
        vm.prank(owner);
        reg.setDepositHook(address(n));
        address w = makeAddr("w7");
        quote.mint(w, 1 ether);
        vm.startPrank(w);
        reg.tryAttribute(w, kol);
        quote.approve(address(n), type(uint256).max);
        vm.expectRevert(UsdgDepositNotifier.SelfDeposit.selector);
        n.deposit(w, 1 ether);
        vm.stopPrank();
        assertEq(reg.usdgDeposited(w), 0);
        // a real third-party transfer still counts
        address payer = makeAddr("payer7");
        quote.mint(payer, Constants.REFERRAL_USDG_GATE);
        vm.startPrank(payer);
        quote.approve(address(n), type(uint256).max);
        n.deposit(w, Constants.REFERRAL_USDG_GATE);
        vm.stopPrank();
        assertEq(reg.referrerOf(w), kol);
    }

    /// #8 LOW: the graduating buy charges (to 1e-12) the minimum quote that buys the remaining supply.
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

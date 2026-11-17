// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {SqrtPrice} from "../../src/libraries/SqrtPrice.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract Mock6 is ERC20 {
    constructor() ERC20("Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @notice Frontend API surface: Trade event, quoters, recipient/permit paths, oracle pricing, router.
abstract contract FrontendApiBase is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes32 constant TRADE_TOPIC =
        keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)");
    /// @dev DiscipleHook (post-grad) variant: last field is uint160 sqrtPriceAfter instead of uint256 mcapAfterUsd (G-1).
    bytes32 constant HOOK_TRADE_TOPIC =
        keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint160)");

    struct T {
        address token;
        address trader;
        bool isBuy;
        uint256 quoteAmt;
        uint256 tokenAmt;
        uint256 fee;
        uint256 snipeFee;
        uint256 pBefore;
        uint256 pAfter;
        uint256 impact;
        uint256 mcap; // curve Trade only (0 for the hook)
        uint160 sqrtAfter; // hook Trade only (0 for the curve)
    }

    function _lastTrade(address emitter) internal returns (T memory t, bool found) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter != emitter || l.topics.length != 3) continue;
            if (l.topics[0] == TRADE_TOPIC) {
                (t.isBuy, t.quoteAmt, t.tokenAmt, t.fee, t.snipeFee, t.pBefore, t.pAfter, t.impact, t.mcap) =
                    abi.decode(l.data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            } else if (l.topics[0] == HOOK_TRADE_TOPIC) {
                (t.isBuy, t.quoteAmt, t.tokenAmt, t.fee, t.snipeFee, t.pBefore, t.pAfter, t.impact, t.sqrtAfter) =
                    abi.decode(l.data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint160));
            } else {
                continue;
            }
            t.token = address(uint160(uint256(l.topics[1])));
            t.trader = address(uint160(uint256(l.topics[2])));
            return (t, true);
        }
    }
}

contract FrontendApiTest is FrontendApiBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ── Gap 1 + 6: Trade event & quoters on the curve ──

    function test_trade_event_buy_matches_quoteBuy_incl_snipe() public {
        (BondingCurve curve, Token tok) = _launch(100, 0);
        vm.warp(block.timestamp + 2); // inside anti-snipe window
        BondingCurve.BuyQuote memory q = curve.quoteBuy(100 ether);
        assertGt(q.snipeFee, 0, "snipe fee active");
        assertEq(curve.currentSnipeFeeBps(), 300); // 3% at 2s
        uint256 pBefore = curve.priceNow();

        vm.recordLogs();
        uint256 out = _buy(curve, trader1, 100 ether, q.tokensOut);
        (T memory t, bool found) = _lastTrade(address(curve));
        assertTrue(found);
        assertEq(out, q.tokensOut);
        assertEq(t.token, address(tok));
        assertEq(t.trader, trader1);
        assertTrue(t.isBuy);
        assertEq(t.quoteAmt, 100 ether);
        assertEq(t.tokenAmt, out);
        assertEq(t.fee, q.fee);
        assertEq(t.snipeFee, q.snipeFee);
        assertEq(t.pBefore, pBefore);
        assertEq(t.pAfter, curve.priceNow());
        assertEq(t.impact, q.impactBps);
        assertGt(t.impact, 0);
        // impact consistent with X18 prices (within rounding)
        assertApproxEqAbs(t.impact, (t.pAfter - t.pBefore) * 10_000 / t.pBefore, 1);
        assertEq(t.mcap, curve.mcapNow());
    }

    function test_trade_event_sell_matches_quoteSell() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        uint256 bought = _buy(curve, trader1, 500 ether, 0);
        BondingCurve.SellQuote memory q = curve.quoteSell(bought / 2);
        vm.recordLogs();
        uint256 got = _sell(curve, tok, trader1, bought / 2, q.quoteOut);
        (T memory t,) = _lastTrade(address(curve));
        assertEq(got, q.quoteOut);
        assertFalse(t.isBuy);
        assertEq(t.quoteAmt, got);
        assertEq(t.tokenAmt, bought / 2);
        assertEq(t.fee, q.fee);
        assertEq(t.snipeFee, 0);
        assertLt(t.pAfter, t.pBefore);
        assertEq(t.impact, q.impactBps);
    }

    function test_views_priceNow_mcapNow_progress() public {
        (BondingCurve curve,) = _launch(0, 0);
        assertEq(curve.progressBps(), 0);
        assertApproxEqRel(curve.mcapNow(), Constants.START_MCAP_USD, 0.001e18);
        _warpPastSnipe();
        _buy(curve, trader1, 200 ether, 0);
        uint256 prog = curve.progressBps();
        assertEq(prog, curve.tokensSold() * 10_000 / (Constants.TOTAL_SUPPLY * Constants.CURVE_SOLD_BPS / 10_000));
        assertGt(prog, 0);
        _graduate(curve);
        assertEq(curve.progressBps(), 10_000);
        vm.expectRevert(BondingCurve.Graduated.selector);
        curve.quoteBuy(1 ether);
    }

    // ── Gap 3: recipient + permit single-tx paths ──

    function test_buy_and_sell_with_recipient() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        vm.startPrank(trader1);
        quote.approve(address(curve), 100 ether);
        uint256 out = curve.buy(100 ether, 0, block.timestamp + 1, trader2);
        vm.stopPrank();
        assertEq(tok.balanceOf(trader2), out);
        assertEq(curve.balanceOnCurve(trader2), out);
        assertEq(tok.balanceOf(trader1), 0);

        uint256 q0 = quote.balanceOf(kol);
        vm.startPrank(trader2);
        tok.approve(address(curve), out);
        uint256 qOut = curve.sell(out, 0, block.timestamp + 1, kol);
        vm.stopPrank();
        assertEq(quote.balanceOf(kol) - q0, qOut);
    }

    function test_buyWithPermit_and_sellWithPermit_single_tx() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        (address alice, uint256 pk) = makeAddrAndKey("permitAlice");
        quote.mint(alice, 100 ether);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(address(quote), pk, alice, address(curve), 100 ether, dl);
        vm.prank(alice);
        uint256 out = curve.buyWithPermit(100 ether, 0, dl, alice, dl, v, r, s);
        assertEq(tok.balanceOf(alice), out);

        (v, r, s) = _permitSig(address(tok), pk, alice, address(curve), out, dl);
        vm.prank(alice);
        uint256 qOut = curve.sellWithPermit(out, 0, dl, alice, dl, v, r, s);
        assertGt(qOut, 0);
        assertEq(tok.balanceOf(alice), 0);
    }

    function _permitSig(address tokenAddr, uint256 pk, address owner_, address spender, uint256 value, uint256 dl)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 typehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        uint256 nonce = ERC20PermitLike(tokenAddr).nonces(owner_);
        bytes32 structHash = keccak256(abi.encode(typehash, owner_, spender, value, nonce, dl));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ERC20PermitLike(tokenAddr).DOMAIN_SEPARATOR(), structHash));
        return vm.sign(pk, digest);
    }

    // ── Gap 5: oracle pricing ──

    function test_default_STRATEGY_priced_from_pool() public {
        assertEq(pricer.quotePriceUsd(address(strategy)), 1e18); // reference pool at 1:1
        (BondingCurve curve,) = _launchWithQuote(address(0), 0, 0);
        assertEq(curve.quotePriceUsd(), 1e18);
    }

    function test_STRATEGY_at_0p0018_scales_curve_to_usd_targets() public {
        MockUSDG strat = new MockUSDG();
        // usdg raw per strat raw = 0.0018
        bool sIsC0 = uint160(address(strat)) < uint160(address(quote));
        uint256 ratioX192 = sIsC0 ? Math.mulDiv(18e14, 1 << 192, 1e18) : Math.mulDiv(1e18, 1 << 192, 18e14);
        PoolKey memory key = _initRefPool(address(strat), address(quote), uint160(Math.sqrt(ratioX192)));
        vm.prank(owner);
        pricer.setPricePool(address(strat), key);
        uint256 p = pricer.quotePriceUsd(address(strat));
        assertApproxEqRel(p, 18e14, 1e12); // ~$0.0018

        vm.startPrank(owner);
        quoteProbe.setAlwaysPass(address(strat), true);
        pricer.setAllowedQuote(address(strat), true); // only listed quotes launch (maker 2026-11-14)
        vm.stopPrank();
        _warmQuote(address(strat)); // fresh TWAP, so the floor is what refuses it
        // Listed quotes must clear the $10k/side depth floor; this thin test pool doesn't, so the launch is refused.
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.NoRouteAboveFloor.selector, address(strat)));
        _launchWithQuote(address(strat), 0, 0);
        // Unlisted, the registered-pool TWAP still prices it (it just can't be a launch quote).
        vm.prank(owner);
        pricer.setAllowedQuote(address(strat), false);
        assertApproxEqRel(pricer.quotePriceUsd(address(strat)), 18e14, 1e12);
    }

    function test_custom_quote_without_pool_reverts() public {
        MockUSDG other = new MockUSDG();
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.QuoteNotListed.selector, address(other)));
        _launchWithQuote(address(other), 0, 0);
    }

    function test_pricer_unset_reverts_never_defaults_to_1usd() public {
        vm.prank(owner);
        launchpad.setPricer(address(0));
        vm.expectRevert(Launchpad.PricerUnset.selector);
        _launchWithQuote(address(quote), 0, 0);
    }

    function test_pricer_usdg_6dec_scale_and_minLiquidity() public {
        Mock6 u6 = new Mock6();
        QuotePricer p6 = new QuotePricer(owner, manager, address(u6));
        assertEq(p6.quotePriceUsd(address(u6)), 1e30); // 1e18 raw = 1e12 USDG = $1e12

        vm.startPrank(owner);
        pricer.setAllowedQuote(address(strategy), false); // minLiquidity guards the unlisted TWAP path
        pricer.setMinLiquidity(type(uint128).max);
        vm.stopPrank();
        vm.expectRevert();
        pricer.quotePriceUsd(address(strategy));
    }

    function test_setPricePool_rejects_unrelated_or_uninitialized() public {
        PoolKey memory key = strategyUsdgKey;
        key.fee = 500; // not initialized
        vm.prank(owner);
        vm.expectRevert(QuotePricer.BadPool.selector);
        pricer.setPricePool(address(strategy), key);
        vm.prank(trader1);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        pricer.setPricePool(address(strategy), strategyUsdgKey);
    }

    function test_sqrtPrice_fromReserves_precise_for_6dec() public pure {
        // 6-dec quote: priceWad would be ~4 (huge truncation); reserves path is exact to 1 ulp
        uint256 x = 20_300e6;
        uint256 y = 4_310_000_000e18;
        uint160 s = SqrtPrice.fromReserves(x, y, true);
        uint256 back = Math.mulDiv(Math.mulDiv(s, s, 1 << 64), 1e36, 1 << 128); // quote/token * 1e36
        assertApproxEqRel(back, x * 1e36 / y, 1e9);
    }

    // ── Gap 4 + 1: post-grad router + hook Trade event ──

    function test_router_post_grad_buy_sell_quote_and_trade_event() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);

        vm.expectRevert(DiscipleRouter.NotGraduated.selector);
        router.poolKeyOf(address(quote));

        uint256 qIn = 50 ether;
        (uint256 quoted, uint256 qImpact, uint256 qMcap) = router.quoteExactIn(address(tok), true, qIn);
        assertGt(quoted, 0);

        quote.mint(trader2, qIn);
        vm.startPrank(trader2);
        quote.approve(address(router), type(uint256).max);
        vm.expectRevert(DiscipleRouter.Slippage.selector);
        router.buyExactIn(address(tok), qIn, quoted + 1, trader2, block.timestamp + 1);
        vm.expectRevert(DiscipleRouter.Expired.selector);
        router.buyExactIn(address(tok), qIn, 0, trader2, block.timestamp - 1);

        uint256 bal0 = tok.balanceOf(trader2);
        vm.recordLogs();
        uint256 out = router.buyExactIn(address(tok), qIn, quoted, trader2, block.timestamp + 1);
        vm.stopPrank();
        assertEq(out, quoted, "quoter exact");
        assertEq(tok.balanceOf(trader2) - bal0, out);

        bool tIs0 = uint160(address(tok)) < uint160(address(quote));
        PoolId pid = _poolKey(tok).toId();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address tr, bool isBuy, uint256 aIn, uint256 aOut) = _lastPoolTrade(logs);
        assertEq(tr, trader2, "router names the real trader");
        assertTrue(isBuy);
        assertEq(aIn, qIn);
        assertEq(aOut, out);
        (uint160 swapSqrt, address swapSender) = _lastSwap(logs, pid);
        (uint160 spAfter,,,) = manager.getSlot0(pid);
        assertEq(swapSqrt, spAfter, "PoolManager Swap.sqrtPriceX96 == slot0");
        assertEq(swapSender, address(router));
        uint256 evMcap = hook.mcapUsdFromSqrt(swapSqrt, tIs0, hook.quoteUsdOf(pid));
        assertGt(evMcap, Constants.GRADUATION_MCAP_USD * 99 / 100);
        assertEq(evMcap, qMcap, "quoter mcap == mcap derived from the Swap event");
        assertGt(qImpact, 0);

        // sell back via router
        (uint256 sq,,) = router.quoteExactIn(address(tok), false, out);
        vm.startPrank(trader2);
        tok.approve(address(router), out);
        vm.recordLogs();
        uint256 qOut = router.sellExactIn(address(tok), out, sq, trader2, block.timestamp + 1);
        vm.stopPrank();
        assertEq(qOut, sq);
        assertLt(qOut, qIn, "round trip pays fees");
        (tr, isBuy, aIn, aOut) = _lastPoolTrade(vm.getRecordedLogs());
        assertFalse(isBuy);
        assertEq(aIn, out);
        assertEq(aOut, qOut);
    }

    /// Slim hook: the hook emits no events of its own on a swap (trades are read from the PoolManager Swap event).
    function test_hook_emits_no_events() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 10 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(hook), "hook log");
        }
    }

    function _lastPoolTrade(Vm.Log[] memory logs)
        internal
        view
        returns (address trader, bool isBuy, uint256 aIn, uint256 aOut)
    {
        bytes32 topic = keccak256("PoolTrade(address,address,bool,uint256,uint256,address)");
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(router) && l.topics[0] == topic) {
                (isBuy, aIn, aOut,) = abi.decode(l.data, (bool, uint256, uint256, address));
                return (address(uint160(uint256(l.topics[1]))), isBuy, aIn, aOut);
            }
        }
        revert("no PoolTrade");
    }

    /// @dev Last PoolManager Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee) for `pid`.
    function _lastSwap(Vm.Log[] memory logs, PoolId pid) internal view returns (uint160 sqrtP, address sender) {
        bytes32 topic = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(manager) && l.topics[0] == topic && l.topics[1] == PoolId.unwrap(pid)) {
                (,, sqrtP,,,) = abi.decode(l.data, (int128, int128, uint160, uint128, int24, uint24));
                return (sqrtP, address(uint160(uint256(l.topics[2]))));
            }
        }
        revert("no Swap");
    }

    /// @dev mcap precision fix: with a 6-dec USDG quote the WAD spot price is a single-digit integer, so the old
    ///      floored mcap read ~$6K at launch (vs $7K). marketCapUsd/marketCapQuote are now full precision.
    function test_6dec_quote_marketCap_full_precision() public {
        Mock6 u6 = new Mock6();
        QuotePricer p6 = new QuotePricer(owner, manager, address(u6));
        vm.startPrank(owner);
        launchpad.setPricer(address(p6));
        quoteProbe.setAlwaysPass(address(u6), true);
        vm.stopPrank();
        (BondingCurve curve,) = _launchWithQuote(address(u6), 0, 0);
        assertEq(curve.quotePriceUsd(), 1e30);
        // 7B supply made the WAD price single digits (the precision trap); at 1M supply it is ~3,333
        assertGt(curve.spotPriceWad(), 1_000);
        assertApproxEqRel(curve.mcapNow(), Constants.START_MCAP_USD, 0.0001e18);
        assertApproxEqRel(curve.marketCapQuote(), 3_333e6, 0.0001e18);
    }

    function test_18dec_quote_marketCap_unchanged() public {
        (BondingCurve curve,) = _launch(0, 0);
        assertApproxEqRel(curve.mcapNow(), Constants.START_MCAP_USD, 0.0001e18);
        assertApproxEqRel(curve.marketCapQuote(), 3_333e18, 0.0001e18);
        uint256 legacy = Math.mulDiv(curve.spotPriceWad(), Constants.TOTAL_SUPPLY, 1e18);
        assertApproxEqRel(curve.marketCapQuote(), legacy, 1e6); // identical to ~1e-12 for 18-dec
    }

    function test_pricer_scales_by_usdg_decimals_18_and_6() public {
        QuotePricer p18 = new QuotePricer(owner, manager, address(quote)); // 18-dec (testnet mUSDG)
        assertEq(p18.quotePriceUsd(address(quote)), 1e18);
        Mock6 u6 = new Mock6(); // mainnet USDG is 6-dec
        QuotePricer p6 = new QuotePricer(owner, manager, address(u6));
        assertEq(p6.usdgDecimals(), 6);
        assertEq(p6.quotePriceUsd(address(u6)), 1e30);
    }
}

interface ERC20PermitLike {
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {SqrtPrice} from "../../src/libraries/SqrtPrice.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
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
        assertEq(curve.currentSnipeFeeBps(), Constants.ANTI_SNIPE_START_BPS - (7770 * 2) / 7);
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

        vm.prank(owner);
        quoteProbe.setAlwaysPass(address(strat), true);
        (BondingCurve curve,) = _launchWithQuote(address(strat), 0, 0);
        assertEq(curve.quotePriceUsd(), p);
        assertApproxEqRel(curve.mcapNow(), Constants.START_MCAP_USD, 0.001e18);
        // in STRATEGY terms the start mcap is ~ 7000 / 0.0018 = 3.89M STRATEGY
        (,, uint256 x0, uint256 y0) = curve.curveParams();
        assertApproxEqRel(Math.mulDiv(x0, Constants.TOTAL_SUPPLY, y0), uint256(7000e18) * 1e18 / p, 0.001e18);
    }

    function test_custom_quote_without_pool_reverts() public {
        MockUSDG other = new MockUSDG();
        vm.expectRevert(abi.encodeWithSelector(QuotePricer.NoPricePool.selector, address(other)));
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

        vm.prank(owner);
        pricer.setMinLiquidity(type(uint128).max);
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
        vm.expectRevert(QuotePricer.OnlyOwner.selector);
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

        (T memory t, bool found) = _lastTrade(address(hook));
        assertTrue(found, "hook Trade");
        assertEq(t.token, address(tok));
        assertEq(t.trader, trader2, "router passes real trader");
        assertTrue(t.isBuy);
        assertEq(t.quoteAmt, qIn);
        assertEq(t.tokenAmt, out);
        assertGt(t.fee, 0);
        assertEq(t.snipeFee, 0);
        assertGt(t.pAfter, t.pBefore);
        assertGt(t.impact, 0);
        assertEq(t.mcap, 0, "hook Trade has no USD mcap (G-1)");
        (uint160 spAfter,,,) = manager.getSlot0(_poolKey(tok).toId());
        assertEq(t.sqrtAfter, spAfter, "Trade.sqrtPriceAfter == slot0");
        bool tIs0 = uint160(address(tok)) < uint160(address(quote));
        uint256 evMcap = hook.mcapUsdFromSqrt(t.sqrtAfter, tIs0, hook.quoteUsdOf(_poolKey(tok).toId()));
        assertGt(evMcap, Constants.GRADUATION_MCAP_USD * 99 / 100);
        assertEq(t.impact, qImpact, "quoter impact == Trade impact");
        assertEq(evMcap, qMcap, "quoter mcap == mcap derived from Trade.sqrtPriceAfter");

        // sell back via router
        (uint256 sq,,) = router.quoteExactIn(address(tok), false, out);
        vm.startPrank(trader2);
        tok.approve(address(router), out);
        vm.recordLogs();
        uint256 qOut = router.sellExactIn(address(tok), out, sq, trader2, block.timestamp + 1);
        vm.stopPrank();
        assertEq(qOut, sq);
        assertLt(qOut, qIn, "round trip pays fees");
        (t,) = _lastTrade(address(hook));
        assertFalse(t.isBuy);
        assertEq(t.quoteAmt, qOut);
        assertEq(t.tokenAmt, out);
        assertLt(t.pAfter, t.pBefore);
    }

    function test_hook_trade_event_direct_swapper_is_sender() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 10 ether);
        (T memory t, bool found) = _lastTrade(address(hook));
        assertTrue(found);
        assertEq(t.trader, address(swapRouter)); // untrusted router: no hookData attribution
        assertEq(t.quoteAmt, 10 ether);
    }

    function test_graduation_pool_price_matches_curve_reserves() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        PoolKey memory key = _poolKey(tok);
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        (,, uint256 x0, uint256 y0) = curve.curveParams();
        uint256 y = y0 - curve.tokensSold();
        uint256 x = Math.mulDiv(x0, y0, y);
        assertEq(sp, SqrtPrice.fromReserves(x, y, uint160(address(tok)) < uint160(address(quote))));
    }
}

contract FrontendApiFollowupTest is FrontendApiBase {
    using PoolIdLibrary for PoolKey;

    function test_quoteCreatorBuy_matches_launch_and_cap() public {
        uint256 qIn = 20 ether;
        (uint256 tOut, uint256 fee, uint256 snipe, uint256 px, bool over) = launchpad.quoteCreatorBuy(address(0), qIn);
        assertEq(px, 1e18);
        assertEq(snipe, 0, "creator buy anti-snipe exempt");
        assertGt(fee, 0);
        assertFalse(over);
        vm.prank(creator);
        strategy.approve(address(launchpad), qIn);
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "C",
                ticker: "C",
                imageURI: "ipfs://c",
                description: "",
                socialsURI: "",
                quote: address(0),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: qIn,
                creatorBuyMinTokensOut: tOut,
                deadline: block.timestamp + 1
            })
        );
        assertEq(r.creatorTokensBought, tOut, "preview exact");

        // with tax
        (uint256 tOut2,,,,) = launchpad.quoteCreatorBuy(address(quote), qIn, 500);
        assertLt(tOut2, tOut);
        // over cap
        (,,,, bool over2) = launchpad.quoteCreatorBuy(address(0), 5_000 ether);
        assertTrue(over2);
    }

    function test_trusted_router_allowlist_hookData_attribution() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        PoolKey memory key = _poolKey(tok);
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));

        // untrusted: hookData ignored
        vm.recordLogs();
        _swapWithHookData(key, !tokenIsC0, trader1, abi.encode(kol));
        (T memory t,) = _lastTrade(address(hook));
        assertEq(t.trader, address(swapRouter));

        vm.prank(trader1);
        vm.expectRevert(DiscipleHook.OnlyAdmin.selector);
        hook.setTrustedRouter(address(swapRouter), true);
        hook.setTrustedRouter(address(swapRouter), true); // admin = test (V4Deploy)
        assertTrue(hook.isTrustedRouter(address(router)));

        vm.recordLogs();
        _swapWithHookData(key, !tokenIsC0, trader1, abi.encode(kol));
        (t,) = _lastTrade(address(hook));
        assertEq(t.trader, kol, "trusted router credits hookData trader");

        // malformed hookData → sender
        vm.recordLogs();
        _swapWithHookData(key, !tokenIsC0, trader1, hex"1234");
        (t,) = _lastTrade(address(hook));
        assertEq(t.trader, address(swapRouter));
    }

    function _swapWithHookData(PoolKey memory key, bool zeroForOne, address trader, bytes memory hd) internal {
        quote.mint(trader, 5 ether);
        vm.startPrank(trader);
        quote.approve(address(swapRouter), 5 ether);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(5 ether),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hd
        );
        vm.stopPrank();
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
        assertLt(curve.spotPriceWad(), 10); // the precision trap: price WAD is single digits
        assertApproxEqRel(curve.mcapNow(), Constants.START_MCAP_USD, 0.0001e18);
        assertApproxEqRel(curve.marketCapQuote(), 7_000e6, 0.0001e18);
    }

    function test_18dec_quote_marketCap_unchanged() public {
        (BondingCurve curve,) = _launch(0, 0);
        assertApproxEqRel(curve.mcapNow(), Constants.START_MCAP_USD, 0.0001e18);
        assertApproxEqRel(curve.marketCapQuote(), 7_000e18, 0.0001e18);
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

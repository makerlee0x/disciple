// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPrice} from "../../src/libraries/SqrtPrice.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Full lifecycle e2e: launch → snipe → trade → graduate → locked LP persists (NOT burned) → post-grad fees.
contract LifecycleIntegrationTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function test_launch_without_creatorBuy_tax0() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        assertEq(tok.balanceOf(address(curve)), Constants.TOTAL_SUPPLY);
        assertEq(curve.creatorTaxBps(), 0);
        assertFalse(curve.graduated());
        assertEq(antiSnipe.currentFeeBps(address(tok)), Constants.ANTI_SNIPE_START_BPS);
    }

    function test_launch_with_creatorBuy_under_0_77pct() public {
        // Small buy to stay under wallet cap + creator buy max
        uint256 buyQuote = 20 ether;
        (BondingCurve curve, Token tok) = _launch(0, buyQuote);
        uint256 bought = tok.balanceOf(creator);
        assertGt(bought, 0);
        assertLe(bought, FeeMath.creatorBuyMax());
        assertLe(curve.balanceOnCurve(creator), FeeMath.walletCap());
    }

    function test_launch_creatorBuy_reverts_above_0_77pct() public {
        // Huge quote would buy >> 0.77% at start — Launchpad checks after buy
        uint256 huge = 5_000 ether;
        uint256 ts = block.timestamp;
        vm.startPrank(creator);
        quote.approve(address(launchpad), huge);
        vm.expectRevert(); // CreatorBuyTooLarge or WalletCap
        launchpad.launch(
            ILaunchpad.LaunchParams({
                name: "TooBig",
                ticker: "BIG",
                imageURI: "ipfs://x",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: huge,
                creatorBuyMinTokensOut: 0,
                deadline: ts + 1 hours
            })
        );
        vm.stopPrank();
    }

    function test_launch_creatorTax_7pct() public {
        (BondingCurve curve,) = _launch(700, 0);
        assertEq(curve.creatorTaxBps(), 700);
        _warpPastSnipe();
        uint256 before = feeRouter.creatorAccrued(address(curve.token()), creator);
        _buy(curve, trader1, 50 ether, 0);
        // tax + 33% of proto fee accrue to creator
        assertGt(feeRouter.creatorAccrued(address(curve.token()), creator), before);
    }

    function test_antiSnipe_decay_and_70_30_split() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        assertEq(antiSnipe.currentFeeBps(address(tok)), 7770);

        (,,,, uint256 escrow0,,) = lockedLP.positions(address(tok));
        uint256 tre0 = quote.balanceOf(treasury);
        uint256 creator0 = feeRouter.creatorAccrued(address(tok), creator);

        uint256 qIn = 50 ether;
        uint256 expectedSnipe = (qIn * 7770) / 10_000;
        _buy(curve, sniper, qIn, 0);

        (,,,, uint256 escrow1,,) = lockedLP.positions(address(tok));
        uint256 afterSnipe = qIn - expectedSnipe;
        uint256 proto = (afterSnipe * 100) / 10_000;
        uint256 lpFromProto = (proto * 33) / 100;
        assertEq(escrow1 - escrow0, lpFromProto, "snipe no longer to LP");
        assertEq(quote.balanceOf(address(rewardsVault)), (expectedSnipe * 7000) / 10_000, "70% rewards");
        (,, uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(proto);
        assertEq(quote.balanceOf(treasury) - tre0, expectedSnipe - (expectedSnipe * 7000) / 10_000 + tsh + rsh, "30%");

        // Creator only gets protocol-fee slice, not snipe
        assertEq(feeRouter.creatorAccrued(address(tok), creator) - creator0, (proto * 33) / 100);

        // Mid decay
        vm.warp(block.timestamp + 3);
        uint256 mid = antiSnipe.currentFeeBps(address(tok));
        assertGt(mid, 0);
        assertLt(mid, 7770);

        _warpPastSnipe();
        assertEq(antiSnipe.currentFeeBps(address(tok)), 0);
    }

    function test_walletCap_7pct_enforced() public {
        (BondingCurve curve,) = _launch(0, 0);
        _warpPastSnipe();
        vm.startPrank(trader1);
        quote.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.WalletCap.selector);
        curve.buy(100_000 ether, 0, block.timestamp + 1);
        vm.stopPrank();
    }

    function test_buys_sells_then_graduate_at_33k_and_LP_not_burned() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();

        // Round-trip no profit mid-curve
        uint256 tOut = _buy(curve, trader1, 80 ether, 0);
        uint256 qBack = _sell(curve, tok, trader1, tOut / 2, 0);
        assertLe(qBack, 80 ether);

        uint256 mcapBeforeGrad = curve.marketCapUsd();
        assertLt(mcapBeforeGrad, Constants.PEARLY_GATES_MCAP_USD);

        _graduate(curve);
        assertTrue(curve.graduated());
        assertGe(curve.tokensSold(), FeeMath.curveSoldSupply() * 99 / 100);
        // Mcap at/near Pearly Gates (last buy may slightly overshoot sold, mcap check at trigger)
        assertTrue(migration.isGraduated(address(tok)));

        // ── Locked LP must NOT be burned ─────────────────────────────────────
        (,,,,, bool graduated, uint128 storedLiq) = lockedLP.positions(address(tok));
        assertTrue(graduated);
        assertGt(storedLiq, 0, "LockedLP stored liquidity must be > 0 (not burned)");

        PoolKey memory key = lockedLP.getPoolKey(address(tok));
        assertTrue(address(key.hooks) != address(0));
        (int24 tickLower, int24 tickUpper, bytes32 salt) = lockedLP.positionTicks(address(tok));

        // Position owned by LockedLP contract — not zero address, not burned
        (uint128 posLiq,,) = manager.getPositionInfo(key.toId(), address(lockedLP), tickLower, tickUpper, salt);
        assertGt(posLiq, 0, "v4 position liquidity owned by LockedLP > 0");
        assertEq(posLiq, storedLiq);

        // Zero-address owner must NOT hold the liquidity
        (uint128 zeroLiq,,) = manager.getPositionInfo(key.toId(), address(0), tickLower, tickUpper, salt);
        assertEq(zeroLiq, 0, "zero address must not own LP");

        // Pool still has liquidity
        uint128 poolLiq = manager.getLiquidity(key.toId());
        assertGt(poolLiq, 0, "pool liquidity not burned");

        // removeLiquidity permanently disabled
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);

        // collectFees path works (0 pool fee → zeros)
        (uint256 a0, uint256 a1) = lockedLP.collectFees(address(tok));
        assertEq(a0, 0);
        assertEq(a1, 0);

        // Price continuity vs curve end
        CurveMath.Params memory p = CurveMath.makeParams(1e18);
        uint256 priceWad = CurveMath.spotPriceWad(p, FeeMath.curveSoldSupply());
        bool tokenIsC0 = uint160(address(tok)) < uint160(address(quote));
        uint160 expected = SqrtPrice.fromPriceWad(priceWad, tokenIsC0);
        (uint160 actual,,,) = manager.getSlot0(key.toId());
        assertApproxEqRel(uint256(actual), uint256(expected), 0.01e18);
    }

    function test_postGrad_swaps_both_directions_fee_split_and_claims() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);

        // Claim any curve-era creator quote accrual first (isolates post-grad accounting)
        uint256 preAccrued = feeRouter.creatorAccrued(address(tok), creator);
        if (preAccrued > 0) {
            vm.prank(creator);
            feeRouter.claimCreatorFees(address(tok));
        }

        uint256 treTok0 = tok.balanceOf(treasury);
        uint256 creatorTok0 = tok.balanceOf(creator);
        uint256 treQ0 = quote.balanceOf(treasury);
        uint256 creatorQ0 = feeRouter.creatorAccrued(address(tok), creator);

        // quote → token: hook fee in launch token → physical split (creator/treasury get tokens)
        _swapExactInQuoteForToken(tok, trader1, 20 ether);
        assertTrue(
            tok.balanceOf(treasury) > treTok0 || tok.balanceOf(creator) > creatorTok0,
            "post-grad buy: 1% hook fee routed in token"
        );
        // Must not pollute quote-denominated creatorAccrued
        assertEq(feeRouter.creatorAccrued(address(tok), creator), creatorQ0);

        // token → quote: hook fee in quote → 33/33/33/1 + treasury auto-push + claimable creator
        uint256 tBal = tok.balanceOf(trader1);
        require(tBal > 1e18, "trader needs tokens");
        _swapExactInTokenForQuote(tok, trader1, tBal / 10);
        assertTrue(
            quote.balanceOf(treasury) > treQ0 || feeRouter.creatorAccrued(address(tok), creator) > creatorQ0,
            "post-grad sell: 1% hook fee routed in quote"
        );

        uint256 accrued = feeRouter.creatorAccrued(address(tok), creator);
        if (accrued > 0) {
            uint256 bal0 = quote.balanceOf(creator);
            vm.prank(creator);
            feeRouter.claimCreatorFees(address(tok));
            assertEq(quote.balanceOf(creator), bal0 + accrued);
            assertEq(feeRouter.creatorAccrued(address(tok), creator), 0);
        }

        // Locked LP must NOT be burned after swaps
        (,,,,,, uint128 liq) = lockedLP.positions(address(tok));
        assertGt(liq, 0, "LP must persist after swaps (not burned)");
        (int24 tl, int24 tu, bytes32 salt) = lockedLP.positionTicks(address(tok));
        PoolKey memory key = lockedLP.getPoolKey(address(tok));
        (uint128 posLiq,,) = manager.getPositionInfo(key.toId(), address(lockedLP), tl, tu, salt);
        assertGt(posLiq, 0, "v4 position owned by LockedLP persists");

        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);
        (uint256 a0, uint256 a1) = lockedLP.collectFees(address(tok));
        assertEq(a0 + a1, 0); // pool LP fee=0
    }

    function test_slippage_and_deadline_reverts() public {
        (BondingCurve curve,) = _launch(0, 0);
        _warpPastSnipe();
        vm.startPrank(trader1);
        quote.approve(address(curve), 10 ether);
        vm.expectRevert(BondingCurve.Slippage.selector);
        curve.buy(10 ether, type(uint256).max, block.timestamp + 1);
        vm.expectRevert(BondingCurve.Expired.selector);
        curve.buy(10 ether, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_accounting_quote_in_equals_distributed() public {
        totalQuoteIn = 0;
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        _buy(curve, trader1, 50 ether, 0);
        _buy(curve, trader2, 50 ether, 0);
        // Before graduation: distributed ≈ totalQuoteIn (fees + reserve)
        uint256 distributed = _quoteDistributed(address(tok), creator);
        // Allow small slack for dust / rounding
        assertApproxEqRel(distributed, totalQuoteIn, 0.02e18);
    }
}

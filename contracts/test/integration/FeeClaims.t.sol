// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CurveFeeVault} from "../../src/CurveFeeVault.sol";
import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {IHookTradeEvents} from "../../src/interfaces/ITradeEvents.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Accrue-then-claim fee balances (gas optimisation): treasury, creator (quote + token side), referrer.
contract FeeClaimsTest is IntegrationBase {
    function test_treasuryAccruesThenClaims() public {
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        uint256 t0 = quote.balanceOf(treasury);
        _buy(c, trader1, 100 * U, 0);
        assertEq(quote.balanceOf(treasury), t0, "no per-trade push");
        (, , uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(FeeMath.protocolFee(100 * U));
        // lp-accrue: curve-phase fees accrue on the curve, then settle into CurveFeeVault (claimTreasury settles the listed coins)
        address[] memory toks = new address[](1);
        toks[0] = address(c.token());
        vm.prank(trader2); // permissionless
        uint256 acc = feeVault.claimTreasury(address(quote), toks);
        assertEq(acc, tsh + rsh, "33% + unrouted 1%");
        assertEq(quote.balanceOf(treasury) - t0, acc);
        assertEq(feeVault.treasuryAccrued(address(quote)), 0);
        vm.expectRevert(CurveFeeVault.NothingToClaim.selector);
        feeVault.claimTreasury(address(quote), toks);
    }

    function test_snipeTreasuryShareAccrues() public {
        (BondingCurve c,) = _launch(0, 0);
        uint256 t0 = quote.balanceOf(treasury);
        _buy(c, sniper, 10 * U, 0); // inside the 7s sniper-tax window
        assertEq(quote.balanceOf(treasury), t0);
        c.settleFees(); // lp-accrue: curve-phase fees accrue in CurveFeeVault
        assertGt(feeVault.treasuryAccrued(address(quote)), 0);
    }

    function test_postGradTokenSideFeesAccrue() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        uint256 cTok0 = tok.balanceOf(creator);
        _swapExactInQuoteForToken(tok, trader1, 100 * U); // buy: hook fee charged in TOKEN
        assertEq(tok.balanceOf(creator), cTok0, "no push to creator");
        uint256 accd = feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGt(accd, 0, "creator token-side accrued");
        assertGt(feeRouter.treasuryAccrued(address(tok)), 0, "treasury token-side accrued");
        vm.prank(creator);
        feeRouter.claimCreatorTokenFees(address(tok));
        assertEq(tok.balanceOf(creator) - cTok0, accd);
        vm.prank(creator);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        feeRouter.claimCreatorTokenFees(address(tok));
        uint256 tt0 = tok.balanceOf(treasury);
        uint256 ta = feeRouter.treasuryAccrued(address(tok));
        feeRouter.claimTreasury(address(tok));
        assertEq(tok.balanceOf(treasury) - tt0, ta);
    }

    /// @dev Slim hook (2026-11-17) emits no events: a buy's 1% fee is taken in TOKEN (the unspecified side) and lands
    ///      in FeeRouter, so the trader receives 99% of the swap output.
    function test_postGradBuyFeeIsOnePercentInToken() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        uint256 fr0 = tok.balanceOf(address(feeRouter)) + tok.balanceOf(address(lockedLP));
        _swapExactInQuoteForToken(tok, trader1, 100 * U);
        uint256 got = tok.balanceOf(trader1);
        uint256 fee = tok.balanceOf(address(feeRouter)) + tok.balanceOf(address(lockedLP)) - fr0;
        assertApproxEqRel(fee, (got + fee) / 100, 0.001e18, "fee = 1% of the token output");
    }

    function test_feeRouterSolventAfterClaims() public {
        (BondingCurve c, Token tok) = _launch(100, 0);
        _graduate(c);
        _swapExactInQuoteForToken(tok, trader1, 50 * U);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        // every accrued balance is backed by FeeRouter holdings
        uint256 owedQ = feeRouter.treasuryAccrued(address(quote)) + feeRouter.creatorAccrued(address(tok), creator);
        uint256 owedT = feeRouter.treasuryAccrued(address(tok)) + feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGe(quote.balanceOf(address(feeRouter)), owedQ);
        assertGe(tok.balanceOf(address(feeRouter)), owedT);
    }
}

/// @notice 6-decimal USDG run of FeeClaimsTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract FeeClaims6DecTest is FeeClaimsTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

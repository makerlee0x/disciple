// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";

/// @notice Accrue-then-claim fee balances (gas optimisation): treasury, creator (quote + token side), referrer.
contract FeeClaimsTest is IntegrationBase {
    function test_treasuryAccruesThenClaims() public {
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        uint256 t0 = quote.balanceOf(treasury);
        _buy(c, trader1, 100 * U, 0);
        assertEq(quote.balanceOf(treasury), t0, "no per-trade push");
        (, , uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(FeeMath.protocolFee(100 * U));
        uint256 acc = feeRouter.treasuryAccrued(address(quote));
        assertEq(acc, tsh + rsh, "33% + unrouted 1%");
        vm.prank(trader2); // permissionless
        feeRouter.claimTreasury(address(quote));
        assertEq(quote.balanceOf(treasury) - t0, acc);
        assertEq(feeRouter.treasuryAccrued(address(quote)), 0);
        vm.expectRevert(FeeRouter.NothingToClaim.selector);
        feeRouter.claimTreasury(address(quote));
    }

    function test_snipeTreasuryShareAccrues() public {
        (BondingCurve c,) = _launch(0, 0);
        uint256 t0 = quote.balanceOf(treasury);
        _buy(c, sniper, 10 * U, 0); // inside the 7s anti-snipe window
        assertEq(quote.balanceOf(treasury), t0);
        assertGt(feeRouter.treasuryAccrued(address(quote)), 0);
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

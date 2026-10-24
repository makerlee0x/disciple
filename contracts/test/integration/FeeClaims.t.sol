// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
        _buy(c, trader1, 100 ether, 0);
        assertEq(quote.balanceOf(treasury), t0, "no per-trade push");
        (, , uint256 tsh, uint256 rsh) = FeeMath.splitTradeFee(FeeMath.protocolFee(100 ether));
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
        _buy(c, sniper, 10 ether, 0); // inside the 7s sniper-tax window
        assertEq(quote.balanceOf(treasury), t0);
        assertGt(feeRouter.treasuryAccrued(address(quote)), 0);
    }

    function test_postGradTokenSideFeesAccrue() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        uint256 cTok0 = tok.balanceOf(creator);
        _swapExactInQuoteForToken(tok, trader1, 100 ether); // buy: hook fee charged in TOKEN
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

    /// @dev 6-dec fix: the hook Trade event's `fee` for a token-side fee is valued in quote from sqrtPriceX96,
    ///      not via the floored WAD price (a single-digit integer at 6-dec USDG ⇒ up to ~25% off). Cherry-pick of
    ///      #115 80b06f22 (18-dec harness here; the 6-dec case is exercised by the #131 fork smoke).
    function test_postGradBuyEventFeeIsOnePercentInQuote() public {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        vm.recordLogs();
        _swapExactInQuoteForToken(tok, trader1, 100 ether); // buy: 1% hook fee charged in TOKEN
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != IHookTradeEvents.Trade.selector) continue;
            (, uint256 quoteAmt,, uint256 fee,,,,,) = abi.decode(
                logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
            );
            assertEq(quoteAmt, 100 ether);
            assertApproxEqRel(fee, quoteAmt / 100, 0.02e18, "token-side fee valued at spot ~= 1% of quote in");
            seen = true;
        }
        assertTrue(seen, "hook Trade");
    }

    function test_feeRouterSolventAfterClaims() public {
        (BondingCurve c, Token tok) = _launch(100, 0);
        _graduate(c);
        _swapExactInQuoteForToken(tok, trader1, 50 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 2);
        // every accrued balance is backed by FeeRouter holdings
        uint256 owedQ = feeRouter.treasuryAccrued(address(quote)) + feeRouter.creatorAccrued(address(tok), creator);
        uint256 owedT = feeRouter.treasuryAccrued(address(tok)) + feeRouter.creatorTokenAccrued(address(tok), creator);
        assertGe(quote.balanceOf(address(feeRouter)), owedQ);
        assertGe(tok.balanceOf(address(feeRouter)), owedT);
    }
}

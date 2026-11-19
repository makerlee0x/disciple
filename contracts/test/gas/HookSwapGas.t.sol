// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";

/// @notice Per-swap gas of a graduated pool through DiscipleHook (maker 2026-11-19: "traders must not pay more gas
///         than they do today"). Every contract the swap may touch is cooled before each measured swap, so each one is
///         priced like a fresh transaction (EIP-2929 cold account + cold slots). Only pre-existing test helpers are
///         used, so this exact file also runs on the pre-change commit (75e08bc) to produce the BEFORE numbers.
///         BEFORE (75e08bc, #461 hook → FeeRouter.routeHookFee → LockedLP credit), same file, forge 1.7.0 / solc 0.8.26:
///         buy 211,709 / sell 202,884. AFTER (this hook: 6909 mint + one SSTORE): buy 152,649 / sell 144,270.
contract HookSwapGasTest is IntegrationBase {
    /// @dev Measured on 75e08bc with this file (see the PR). The new hook must not exceed them.
    uint256 internal constant BEFORE_BUY = 211_709;
    uint256 internal constant BEFORE_SELL = 202_884;

    function _coolAll(Token tok, address trader) internal {
        address[11] memory a = [
            address(hook),
            address(feeRouter),
            address(lockedLP),
            address(launchpad),
            address(referrals),
            address(manager),
            address(tok),
            address(quote),
            address(swapRouter),
            trader,
            address(migration)
        ];
        for (uint256 i; i < a.length; ++i) {
            vm.cool(a[i]);
        }
    }

    function _measure() internal returns (uint256 buyGas, uint256 sellGas) {
        (BondingCurve c, Token tok) = _launch(0, 0);
        _graduate(c);
        // first trades: create balances / fee slots (one-time costs for a pool), then measure steady-state trades
        _swapExactInQuoteForToken(tok, trader1, 100 * U);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 4);

        quote.mint(trader1, 100 * U); // mint outside the measured window
        _coolAll(tok, trader1);
        uint256 g = gasleft();
        _swapExactInQuoteForToken(tok, trader1, 50 * U);
        buyGas = g - gasleft();
        uint256 sellAmt = tok.balanceOf(trader1) / 4;
        _coolAll(tok, trader1);
        g = gasleft();
        _swapExactInTokenForQuote(tok, trader1, sellAmt);
        sellGas = g - gasleft();
        console2.log("hook swap gas: buy", buyGas);
        console2.log("hook swap gas: sell", sellGas);
    }

    function test_gas_hookSwap_notAboveBefore() public {
        (uint256 b, uint256 s) = _measure();
        assertLe(b, BEFORE_BUY, "buy gas above the pre-change hook");
        assertLe(s, BEFORE_SELL, "sell gas above the pre-change hook");
    }
}

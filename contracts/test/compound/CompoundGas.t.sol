// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Gas measurement for post-grad swaps (uses only APIs that exist pre- and post-compound, so it can be
///         run on the base branch for an apples-to-apples delta). Each swap is a separate tx-like call; numbers
///         are the gas consumed by PoolSwapTest.swap incl. hook + FeeRouter (+ compound when it fires).
contract CompoundGasTest is IntegrationBase {
    bytes32 constant COMPOUNDED =
        keccak256("LiquidityCompounded(address,uint128,uint256,uint256,uint256,uint256)");

    function _measuredBuy(Token tok, uint256 amt) internal returns (uint256 g, bool added) {
        vm.recordLogs();
        uint256 g0 = gasleft();
        _swapExactInQuoteForToken(tok, trader1, amt);
        g = g0 - gasleft();
        added = _sawCompound();
    }

    function _measuredSell(Token tok, uint256 amt) internal returns (uint256 g, bool added) {
        vm.recordLogs();
        uint256 g0 = gasleft();
        _swapExactInTokenForQuote(tok, trader1, amt);
        g = g0 - gasleft();
        added = _sawCompound();
    }

    function _sawCompound() internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == COMPOUNDED) return true;
        }
        return false;
    }

    function test_gas_postGradSwaps() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _graduate(curve);
        // warm-up both directions (cold slots)
        _swapExactInQuoteForToken(tok, trader1, 50 ether);
        _swapExactInTokenForQuote(tok, trader1, tok.balanceOf(trader1) / 4);
        for (uint256 i; i < 6; i++) {
            (uint256 gb, bool ab) = _measuredBuy(tok, 100 ether);
            console2.log("buy  gas", gb, ab ? "ADD" : "no-add");
            (uint256 gs, bool as_) = _measuredSell(tok, tok.balanceOf(trader1) / 3);
            console2.log("sell gas", gs, as_ ? "ADD" : "no-add");
        }
    }
}

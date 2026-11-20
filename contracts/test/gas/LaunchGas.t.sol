// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";

/// @notice Launch gas and curve trade gas (maker 2026-11-20: clone Token and BondingCurve). Uses only pre-existing
///         helpers, so this exact file also runs on the pre-clone commit for the BEFORE numbers (see the PR).
///         Every contract a trade touches is cooled first, so a trade is priced like a fresh transaction.
///         forge 1.5.1, BEFORE (8568571, full Token + BondingCurve per coin) → AFTER (EIP-1167 clones):
///         launch 6,561,827 → 837,256; curve buy 130,923 → 138,411; curve sell 119,700 → 126,840.
///         Graduated pool (HookSwapGas, same forge): buy 152,752 → 155,758; sell 146,507 → 150,019.
///         The trade increase is the clones' DELEGATECALL (cold implementation account) on the curve and the token.
contract LaunchGasTest is IntegrationBase {
    function _cool(BondingCurve c, Token tok, address trader) internal {
        address[8] memory a = [
            address(c),
            address(tok),
            address(quote),
            address(feeRouter),
            address(launchpad),
            address(referrals),
            address(migration),
            trader
        ];
        for (uint256 i; i < a.length; ++i) {
            vm.cool(a[i]);
        }
    }

    uint256 internal constant LAUNCH_MAX = 1_500_000; // maker 2026-11-20 target: about 1-1.5M per launch

    function test_gas_launchAndCurveTrades() public {
        vm.cool(address(launchpad));
        uint256 g = gasleft();
        (BondingCurve c, Token tok) = _launch(0, 0);
        uint256 launchGas = g - gasleft();
        console2.log("launch gas (no First BOOST)", launchGas);
        assertLe(launchGas, LAUNCH_MAX, "launch gas above the clone target");

        // second launch: warm factory code paths are not the point, cool again
        vm.cool(address(launchpad));
        g = gasleft();
        _launch(0, 0);
        console2.log("launch gas (second coin)", g - gasleft());

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.roll(vm.getBlockNumber() + 300);
        _buy(c, trader1, 10 * U, 0); // first buy creates the trader's slots
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.roll(vm.getBlockNumber() + 300);

        vm.startPrank(trader1);
        quote.approve(address(c), 10 * U);
        tok.approve(address(c), type(uint256).max);
        vm.stopPrank();

        _cool(c, tok, trader1);
        vm.prank(trader1);
        g = gasleft();
        c.buy(10 * U, 0, vm.getBlockTimestamp() + 1 hours);
        uint256 buyGas = g - gasleft();
        console2.log("curve buy gas", buyGas);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.roll(vm.getBlockNumber() + 300);
        uint256 amt = tok.balanceOf(trader1) / 4;
        _cool(c, tok, trader1);
        vm.prank(trader1);
        g = gasleft();
        c.sell(amt, 0, vm.getBlockTimestamp() + 1 hours);
        console2.log("curve sell gas", g - gasleft());
    }
}

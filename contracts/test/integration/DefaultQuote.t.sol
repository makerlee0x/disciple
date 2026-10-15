// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase, MockUSDG} from "./IntegrationBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @notice defaultQuote (STRATEGY) + custom quote via probe; pool fee stays 0.
contract DefaultQuoteIntegrationTest is IntegrationBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function test_launchCoin_quoteZero_uses_defaultSTRATEGY() public {
        assertEq(launchpad.defaultQuote(), address(strategy));
        (BondingCurve curve, Token tok) = _launchWithQuote(address(0), 0, 0);
        assertEq(curve.quote(), address(strategy));
        assertEq(feeRouter.tokenQuote(address(tok)), address(strategy));

        _graduateWith(curve, strategy);
        assertTrue(curve.graduated());

        (,,,,,, uint128 liq) = lockedLP.positions(address(tok));
        assertGt(liq, 0, "LockedLP not burned");
        PoolKey memory key = lockedLP.getPoolKey(address(tok));
        assertEq(uint256(key.fee), 0, "v4 pool LP fee must stay 0 (1% hook only)");
        (int24 tl, int24 tu, bytes32 salt) = lockedLP.positionTicks(address(tok));
        (uint128 posLiq,,) = manager.getPositionInfo(key.toId(), address(lockedLP), tl, tu, salt);
        assertGt(posLiq, 0);
        vm.expectRevert(LockedLP.RemoveLiquidityDisabled.selector);
        lockedLP.removeLiquidity(address(tok), 1);
        lockedLP.collectFees(address(tok));
    }

    function test_custom_quote_via_probe_still_allowed() public {
        (BondingCurve curve,) = _launchWithQuote(address(quote), 0, 0);
        assertEq(curve.quote(), address(quote));
    }

    function test_setDefaultQuote_onlyOwner() public {
        vm.prank(trader1);
        vm.expectRevert();
        launchpad.setDefaultQuote(address(quote));
        vm.prank(owner);
        launchpad.setDefaultQuote(address(quote));
        assertEq(launchpad.defaultQuote(), address(quote));
    }

    function test_launch_emits_LaunchTierContext_for_indexer() public {
        vm.recordLogs();
        (, Token tok) = _launchWithQuote(address(0), 0, 0);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("LaunchTierContext(address,uint256,uint256,uint256,uint8)");
        bool found;
        for (uint256 i; i < entries.length; i++) {
            if (entries[i].topics.length > 0 && entries[i].topics[0] == topic0) {
                found = true;
                assertEq(address(uint160(uint256(entries[i].topics[1]))), address(tok));
            }
        }
        assertTrue(found, "LaunchTierContext must emit for offchain tiers");
    }
}

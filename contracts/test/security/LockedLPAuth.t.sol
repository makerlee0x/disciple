// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../integration/IntegrationBase.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";

/// @notice SEC-01: LockedLP.addLockedLiquidity was unauthenticated → anyone could overflow a coin's escrowQuote
///         with a worthless token so every later fee routing (all curve trades) reverted (coin bricked).
contract LockedLPAuthTest is IntegrationBase {
    function test_attacker_cannot_poison_escrow() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        address attacker = makeAddr("attacker");
        MockUSDG junk = new MockUSDG();
        junk.mint(attacker, type(uint256).max);
        vm.startPrank(attacker);
        junk.approve(address(lockedLP), type(uint256).max);
        vm.expectRevert(LockedLP.Unauthorized.selector);
        lockedLP.addLockedLiquidity(address(tok), address(junk), 0, type(uint256).max - 1);
        vm.stopPrank();
        // trading still works
        assertGt(_buy(curve, trader1, 10 ether, 0), 0);
    }

    function test_feeRouter_and_migration_still_authorized() public {
        (BondingCurve curve,) = _launch(0, 0);
        _warpPastSnipe();
        _buy(curve, trader1, 10 ether, 0); // FeeRouter → addLockedLiquidity
        _graduate(curve); // Migration → addLockedLiquidity
        assertTrue(curve.graduated());
    }

    function test_setFeeRouter_onlyOwner() public {
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        lockedLP.setFeeRouter(address(1));
    }
}

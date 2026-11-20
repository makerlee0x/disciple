// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DiscipleHook} from "../../src/DiscipleHook.sol";
import {Migration} from "../../src/Migration.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {CurveDeployer} from "../../src/CurveDeployer.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice maker 2026-11-19: the owner can point NEW coins at a new hook (Migration.setHook) or new curve code
///         (Launchpad.setCurveDeployer) at once, with nothing else redeployed, until each is locked for good.
///         Coins already graduated keep their pool's hook.
contract SwapHookAndCurveTest is IntegrationBase {
    address internal constant COMMUNITY2 = address(0xC0FFEE0002);
    address internal bot = makeAddr("bot");

    function _newHook(address migration_) internal returns (DiscipleHook h) {
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory args = abi.encode(manager, address(0), address(this), treasury, COMMUNITY2);
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(DiscipleHook).creationCode, args);
        h = new DiscipleHook{salt: salt}(manager, address(0), address(this), treasury, COMMUNITY2);
        h.setMigration(migration_);
        h.setCreatorFeeHarvest(address(harvest));
    }

    function _routerTrade(Token tok) internal {
        vm.startPrank(trader1);
        quote.approve(address(router), type(uint256).max);
        tok.approve(address(router), type(uint256).max);
        router.buyExactIn(address(tok), 200 * U, 1, trader1, block.timestamp + 60);
        router.sellExactIn(address(tok), tok.balanceOf(trader1) / 2, 1, trader1, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_newHook_forNewCoinsOnly_oldCoinKeepsItsHook() public {
        (BondingCurve c1, Token t1) = _launch(0, 0);
        _graduate(c1);
        assertEq(migration.hookOf(address(t1)), address(hook));

        DiscipleHook h2 = _newHook(address(migration));
        vm.prank(owner);
        migration.setHook(address(h2));
        assertTrue(migration.isHook(address(h2)) && migration.isHook(address(hook)));

        (BondingCurve c2, Token t2) = _launch(0, 0);
        _graduate(c2);
        assertEq(migration.hookOf(address(t2)), address(h2), "new coin on the new hook");
        assertEq(address(router.poolKeyOf(address(t2)).hooks), address(h2));
        assertEq(address(router.poolKeyOf(address(t1)).hooks), address(hook), "old coin keeps its hook");

        // both trade through the same router; each hook books only its own coin
        _routerTrade(t1);
        _routerTrade(t2);
        (uint256 q1,) = hook.claimable(address(t1), 2);
        (uint256 q2,) = h2.claimable(address(t2), 2);
        assertGt(q1, 0);
        assertGt(q2, 0);

        // the new hook's claims work end to end, including the LockedLP credit
        (uint256 lq, uint256 lt) = h2.claimable(address(t2), 1);
        (uint256 bT, uint256 bQ) = lockedLP.compoundBucket(address(t2));
        (uint256 kq,) = h2.claimable(address(t2), 3);
        vm.startPrank(bot);
        h2.claimLockedLiquidityFees(address(t2));
        h2.claimCommunityFees(address(t2));
        h2.claimCreatorFees(address(t2));
        vm.stopPrank();
        (uint256 bT2, uint256 bQ2) = lockedLP.compoundBucket(address(t2));
        assertEq(bT2 - bT, lt);
        assertEq(bQ2 - bQ, lq);
        assertEq(quote.balanceOf(COMMUNITY2), kq, "new hook's own community Safe");
    }

    function test_hookOfOtherCoin_cannotCreditLockedLP() public {
        (BondingCurve c1, Token t1) = _launch(0, 0);
        _graduate(c1);
        DiscipleHook h2 = _newHook(address(migration));
        vm.prank(owner);
        migration.setHook(address(h2));
        vm.prank(address(h2)); // h2 is a known hook, but not t1's
        vm.expectRevert();
        lockedLP.creditLockedLiquidity(address(t1), address(quote), 1, 1);
    }

    function test_setHook_checks_andLock() public {
        DiscipleHook h2 = _newHook(address(migration));
        vm.prank(trader1);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        migration.setHook(address(h2));

        DiscipleHook other = _newHook(address(lockedLP)); // wired to another Migration
        vm.startPrank(owner);
        vm.expectRevert(Migration.BadHook.selector);
        migration.setHook(address(other));
        vm.expectRevert(Migration.BadHook.selector);
        migration.setHook(address(lockedLP)); // no hook flags
        migration.lockHook();
        vm.expectRevert(Migration.HookLocked.selector);
        migration.setHook(address(h2));
        vm.stopPrank();
    }

    function test_newCurveDeployer_forNewCoins_andLock() public {
        (BondingCurve c1,) = _launch(0, 0);
        CurveDeployer d2 = new CurveDeployer(address(feeVault), address(launchpad));
        vm.prank(trader1);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCurveDeployer(address(d2));
        vm.prank(owner);
        launchpad.setCurveDeployer(address(d2));
        assertEq(address(launchpad.curveDeployer()), address(d2));
        (BondingCurve c2, Token t2) = _launch(0, 0);
        assertTrue(address(c2) != address(c1));
        _buy(c2, trader2, 10 * U, 0);
        assertGt(t2.balanceOf(trader2), 0, "new coin trades on the new curve code");
        _graduate(c2);

        CurveDeployer d3 = new CurveDeployer(address(feeVault), address(launchpad));
        vm.startPrank(owner);
        launchpad.lockCurveDeployer();
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCurveDeployer(address(d3));
        vm.stopPrank();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {LockedLP} from "../../src/LockedLP.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {Migration} from "../../src/Migration.sol";
import {QuoteProbe} from "../../src/QuoteProbe.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {MockUSDG} from "../integration/IntegrationBase.sol";

/// @notice Two-step ownership (transferOwnership + acceptOwnership) on every contract whose owner used to be
///         constructor-only (LockedLP, FeeRouter, Launchpad, Migration, QuoteProbe) plus QuotePricer.
contract OwnershipTest is Test {
    address owner = makeAddr("owner");
    address next = makeAddr("next");
    address rando = makeAddr("rando");

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function _all() internal returns (Owned2Step[6] memory c) {
        MockUSDG usdg = new MockUSDG();
        QuotePricer pricer = new QuotePricer(owner, IPoolManager(address(0xBEEF)), address(usdg));
        c[0] = new LockedLP(owner, makeAddr("treasury"));
        c[1] = new FeeRouter(owner, makeAddr("treasury"), makeAddr("referrals"));
        c[2] = new Launchpad(owner, makeAddr("fr"), makeAddr("as"), makeAddr("mig"));
        c[3] = new Migration(owner, makeAddr("llp"), makeAddr("pm"), makeAddr("hook"));
        c[4] = new QuoteProbe(owner, IPoolManager(address(0xBEEF)), address(usdg), address(pricer), 1e18);
        c[5] = pricer;
    }

    function test_twoStep_allContracts() public {
        Owned2Step[6] memory c = _all();
        for (uint256 i; i < c.length; ++i) {
            Owned2Step o = c[i];
            assertEq(o.owner(), owner);
            assertEq(o.pendingOwner(), address(0));

            vm.prank(rando);
            vm.expectRevert(Owned2Step.OnlyOwner.selector);
            o.transferOwnership(next);

            vm.expectEmit(address(o));
            emit OwnershipTransferStarted(owner, next);
            vm.prank(owner);
            o.transferOwnership(next);
            assertEq(o.owner(), owner, "nomination alone changes nothing");
            assertEq(o.pendingOwner(), next);

            vm.prank(rando);
            vm.expectRevert(Owned2Step.NotPendingOwner.selector);
            o.acceptOwnership();

            vm.expectEmit(address(o));
            emit OwnershipTransferred(owner, next);
            vm.prank(next);
            o.acceptOwnership();
            assertEq(o.owner(), next);
            assertEq(o.pendingOwner(), address(0));

            // old owner lost control
            vm.prank(owner);
            vm.expectRevert(Owned2Step.OnlyOwner.selector);
            o.transferOwnership(owner);
        }
    }

    function test_cancelNomination() public {
        Owned2Step[6] memory c = _all();
        for (uint256 i; i < c.length; ++i) {
            vm.startPrank(owner);
            c[i].transferOwnership(next);
            c[i].transferOwnership(address(0)); // cancel
            vm.stopPrank();
            vm.prank(next);
            vm.expectRevert(Owned2Step.NotPendingOwner.selector);
            c[i].acceptOwnership();
            assertEq(c[i].owner(), owner);
        }
    }

    function test_newOwnerControlsSetters() public {
        Owned2Step[6] memory c = _all();
        for (uint256 i; i < c.length; ++i) {
            vm.prank(owner);
            c[i].transferOwnership(next);
            vm.prank(next);
            c[i].acceptOwnership();
        }
        address t2 = makeAddr("t2");
        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        LockedLP(address(c[0])).setTreasury(t2);
        vm.prank(next);
        LockedLP(address(c[0])).setTreasury(t2);
        assertEq(LockedLP(address(c[0])).treasury(), t2);

        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        FeeRouter(address(c[1])).setTreasury(t2);
        vm.prank(next);
        FeeRouter(address(c[1])).setTreasury(t2);

        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        Launchpad(address(c[2])).setWalletCapBps(100);
        vm.prank(next);
        Launchpad(address(c[2])).setWalletCapBps(100);

        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        Migration(address(c[3])).setLaunchpad(t2);
        vm.prank(next);
        Migration(address(c[3])).setLaunchpad(t2);

        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        QuoteProbe(address(c[4])).setAlwaysPass(t2, true);
        vm.prank(next);
        QuoteProbe(address(c[4])).setAlwaysPass(t2, true);

        vm.prank(owner);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        QuotePricer(address(c[5])).setMinLiquidity(1);
        vm.prank(next);
        QuotePricer(address(c[5])).setMinLiquidity(1);
    }
}

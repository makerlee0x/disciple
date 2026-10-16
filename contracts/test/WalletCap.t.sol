// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {Token} from "../src/Token.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";

/// @notice Launchpad.walletCapBps: owner-settable per-wallet curve holding cap, default 0 (no cap), snapshotted per coin.
contract WalletCapTest is IntegrationBase {
    event WalletCapSet(uint256 bps);

    function _bigBuy(BondingCurve curve, address who, uint256 quoteIn) internal returns (uint256 out) {
        vm.startPrank(who);
        quote.approve(address(curve), type(uint256).max);
        out = curve.buy(quoteIn, 0, block.timestamp + 1);
        vm.stopPrank();
    }

    function test_default_noCap_largeBuySucceeds() public {
        assertEq(launchpad.walletCapBps(), 0);
        (BondingCurve curve, Token tok) = _launch(0, 0);
        assertEq(curve.walletCapBps(), 0);
        assertEq(launchpad.walletCapBpsOf(address(tok)), 0);
        _warpPastSnipe();
        uint256 out = _bigBuy(curve, trader1, 100_000 ether);
        assertGt(out, FeeMath.walletCap(700), "holds more than the old 7% cap");
        assertEq(curve.balanceOnCurve(trader1), out);
    }

    function test_ownerSetsCap_enforced() public {
        vm.expectEmit(false, false, false, true, address(launchpad));
        emit WalletCapSet(100);
        vm.prank(owner);
        launchpad.setWalletCapBps(100); // 1%
        (BondingCurve curve, Token tok) = _launch(0, 0);
        assertEq(curve.walletCapBps(), 100);
        assertEq(launchpad.walletCapBpsOf(address(tok)), 100);
        _warpPastSnipe();
        vm.startPrank(trader1);
        quote.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.WalletCap.selector);
        curve.buy(100_000 ether, 0, block.timestamp + 1);
        // a small buy under the cap still works, and the cap binds cumulatively
        uint256 out = curve.buy(10 ether, 0, block.timestamp + 1);
        assertLe(out, FeeMath.walletCap(100));
        vm.stopPrank();
    }

    function test_setWalletCap_bounds() public {
        vm.startPrank(owner);
        launchpad.setWalletCapBps(10_000);
        assertEq(launchpad.walletCapBps(), 10_000);
        vm.expectRevert(Launchpad.WalletCapTooHigh.selector);
        launchpad.setWalletCapBps(10_001);
        launchpad.setWalletCapBps(0);
        vm.stopPrank();
    }

    function test_nonOwner_reverts() public {
        vm.prank(trader1);
        vm.expectRevert(Launchpad.OnlyOwner.selector);
        launchpad.setWalletCapBps(700);
    }

    function test_existingCoins_unaffected() public {
        // coin A launched with no cap; coin B launched after owner sets 1%
        (BondingCurve a, Token ta) = _launch(0, 0);
        vm.prank(owner);
        launchpad.setWalletCapBps(100);
        (BondingCurve b,) = _launch(0, 0);
        assertEq(a.walletCapBps(), 0);
        assertEq(launchpad.walletCapBpsOf(address(ta)), 0);
        assertEq(b.walletCapBps(), 100);
        _warpPastSnipe();
        uint256 out = _bigBuy(a, trader1, 100_000 ether); // A stays uncapped
        assertGt(out, FeeMath.walletCap(100));
        vm.startPrank(trader2);
        quote.approve(address(b), type(uint256).max);
        vm.expectRevert(BondingCurve.WalletCap.selector);
        b.buy(100_000 ether, 0, block.timestamp + 1);
        vm.stopPrank();
        // tightening again later does not touch A or B
        vm.prank(owner);
        launchpad.setWalletCapBps(1);
        assertEq(a.walletCapBps(), 0);
        assertEq(b.walletCapBps(), 100);
    }

    function testFuzz_setWalletCap(uint256 bps) public {
        vm.prank(owner);
        if (bps > 10_000) {
            vm.expectRevert(Launchpad.WalletCapTooHigh.selector);
            launchpad.setWalletCapBps(bps);
        } else {
            launchpad.setWalletCapBps(bps);
            assertEq(launchpad.walletCapBps(), bps);
        }
    }
}

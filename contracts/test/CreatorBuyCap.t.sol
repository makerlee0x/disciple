// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./integration/IntegrationBase.sol";
import {Owned2Step} from "../src/utils/Owned2Step.sol";
import {AnonLauncher} from "../src/addons/AnonLauncher.sol";

contract CreatorBuyCapTest is IntegrationBase {
    event CreatorBuyMaxSet(uint256 bps);

    function test_default_77bps() public {
        assertEq(launchpad.creatorBuyMaxBps(), 77);
        (BondingCurve c, Token t) = _launch(0, 10 * U);
        assertEq(launchpad.creatorBuyMaxBpsOf(address(t)), 77);
        c;
        // just above 0.77% reverts by default
        (,,,, bool ex) = launchpad.quoteCreatorBuy(address(quote), 200 * U, 0);
        assertTrue(ex);
        vm.expectRevert(Launchpad.CreatorBuyTooLarge.selector);
        this.launchExt(200 * U);
    }

    function launchExt(uint256 buy) external {
        _launch(0, buy);
    }

    function test_owner_sets_cap_and_bigger_buy_allowed() public {
        vm.expectEmit(address(launchpad));
        emit CreatorBuyMaxSet(500);
        vm.prank(owner);
        launchpad.setCreatorBuyMaxBps(500);
        (uint256 out,,,, bool ex) = launchpad.quoteCreatorBuy(address(quote), 200 * U, 0);
        assertFalse(ex);
        (, Token t) = _launch(0, 200 * U);
        assertEq(t.balanceOf(creator), out);
        assertGt(out, FeeMath.creatorBuyMax());
        assertEq(launchpad.creatorBuyMaxBpsOf(address(t)), 500);
    }

    function test_non_owner_and_creator_revert() public {
        (, Token t) = _launch(0, 0);
        t;
        vm.prank(creator);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCreatorBuyMaxBps(100);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        launchpad.setCreatorBuyMaxBps(100);
    }

    function test_above_7pct_reverts_ceiling_ok() public {
        vm.startPrank(owner);
        vm.expectRevert(Launchpad.CreatorBuyMaxTooHigh.selector);
        launchpad.setCreatorBuyMaxBps(701);
        launchpad.setCreatorBuyMaxBps(700);
        vm.stopPrank();
        assertEq(launchpad.creatorBuyMaxBps(), 700);
    }

    function test_existing_coins_keep_snapshot() public {
        (, Token old) = _launch(0, 10 * U);
        vm.prank(owner);
        launchpad.setCreatorBuyMaxBps(10);
        assertEq(launchpad.creatorBuyMaxBpsOf(address(old)), 77);
        (, Token nu) = _launch(0, 0);
        assertEq(launchpad.creatorBuyMaxBpsOf(address(nu)), 10);
        vm.expectRevert(Launchpad.CreatorBuyTooLarge.selector);
        this.launchExt(10 * U);
    }

    function test_anonLauncher_respects_owner_cap() public {
        AnonLauncher anon =
            new AnonLauncher(owner, address(launchpad), address(feeRouter), address(quote), treasury, address(0), 0);
        address payer = makeAddr("payer");
        quote.mint(payer, 1_000 * U);
        ILaunchpad.LaunchParams memory p = ILaunchpad.LaunchParams({
            name: "A",
            ticker: "A",
            imageURI: "i",
            description: "",
            socialsURI: "",
            quote: address(quote),
            creatorTaxBps: 0,
            creatorBuyQuoteIn: 200 * U,
            creatorBuyMinTokensOut: 0,
            deadline: block.timestamp + 1 hours
        });
        vm.startPrank(payer);
        quote.approve(address(anon), type(uint256).max);
        vm.expectRevert(Launchpad.CreatorBuyTooLarge.selector);
        anon.launchAnon(p, makeAddr("st"), makeAddr("fr"), "", 0x00);
        vm.stopPrank();
        vm.prank(owner);
        launchpad.setCreatorBuyMaxBps(500);
        vm.prank(payer);
        ILaunchpad.LaunchResult memory r = anon.launchAnon(p, makeAddr("st"), makeAddr("fr"), "", 0x00);
        assertEq(IERC20(r.token).balanceOf(makeAddr("fr")), r.creatorTokensBought);
        assertEq(launchpad.creatorBuyMaxBpsOf(r.token), 500);
    }
}

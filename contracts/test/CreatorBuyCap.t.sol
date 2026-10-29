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
        // above 0.77%: flagged by the quote, and (mode rules v2) partially filled instead of reverting
        (uint256 qOut,,,, bool ex) = launchpad.quoteCreatorBuy(address(quote), 200 * U, 0);
        assertTrue(ex);
        assertEq(qOut, FeeMath.creatorBuyMax(), "quote clamps to the max");
        uint256 b0 = quote.balanceOf(creator);
        (, Token t2) = _launch(0, 200 * U);
        assertEq(t2.balanceOf(creator), FeeMath.creatorBuyMax(), "partial fill to the max");
        assertLt(b0 - quote.balanceOf(creator), 200 * U, "refund");
    }

    function launchExt(uint256 buy) external {
        _launch(0, buy);
    }

    function test_owner_sets_cap_and_bigger_buy_allowed() public {
        vm.expectEmit(address(launchpad));
        emit CreatorBuyMaxSet(500);
        vm.prank(owner);
        launchpad.setCreatorBuyMaxBps(500);
        // steep curve ($3,333 start): 100 USDG buys ~2.8% — above the 0.77% default, inside the 5% cap
        (uint256 out,,,, bool ex) = launchpad.quoteCreatorBuy(address(quote), 100 * U, 0);
        assertFalse(ex);
        (, Token t) = _launch(0, 100 * U);
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
        (, Token nu2) = _launch(0, 10 * U);
        assertEq(nu2.balanceOf(creator), FeeMath.creatorBuyMax(10), "partial fill to the new 0.1% max");
        vm.prank(owner);
        launchpad.setCreatorBuyMaxBps(0);
        vm.expectRevert(Launchpad.CreatorBuyTooLarge.selector); // max 0 = First BOOST disabled
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
        uint256 pb0 = quote.balanceOf(payer);
        ILaunchpad.LaunchResult memory r0 = anon.launchAnon(p, makeAddr("st"), makeAddr("fr0"), "", 0x00, type(uint256).max);
        vm.stopPrank();
        assertEq(r0.creatorTokensBought, FeeMath.creatorBuyMax(), "partial fill to 0.77%");
        assertLt(pb0 - quote.balanceOf(payer), 200 ether, "refund forwarded to the payer");
        assertEq(quote.balanceOf(address(anon)), 0, "AnonLauncher keeps nothing");
        vm.prank(owner);
        launchpad.setCreatorBuyMaxBps(500);
        vm.prank(payer);
        ILaunchpad.LaunchResult memory r = anon.launchAnon(p, makeAddr("st"), makeAddr("fr"), "", 0x00, type(uint256).max);
        assertEq(IERC20(r.token).balanceOf(makeAddr("fr")), r.creatorTokensBought);
        assertEq(launchpad.creatorBuyMaxBpsOf(r.token), 500);
    }
}

/// @notice 6-decimal USDG run of CreatorBuyCapTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract CreatorBuyCap6DecTest is CreatorBuyCapTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

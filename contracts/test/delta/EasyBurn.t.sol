// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Token} from "../../src/Token.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Delta a0e5b5b: Easy (PVE) burns before graduation on a REAL curve. The burn must leave the curve's pricing,
/// graduation and LP seed untouched, settle the burner's rewards, drop totalNet by the burned NET, and keep the
/// rewards pool solvent through graduation and every claim.
contract DeltaEasyBurn is IntegrationBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function _buyQ(BondingCurve c, address w, uint256 q) internal {
        quote.mint(w, q);
        vm.startPrank(w);
        quote.approve(address(c), q);
        c.buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function _sellT(BondingCurve c, Token t, address w, uint256 n) internal {
        vm.startPrank(w);
        t.approve(address(c), n);
        c.sell(n, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function _easy() internal returns (BondingCurve c, Token t) {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(
            ILaunchpad.LaunchParams({
                name: "Easy", ticker: "E", imageURI: "ipfs://img", description: "", socialsURI: "",
                quote: address(quote), creatorTaxBps: 0, creatorBuyQuoteIn: 0, creatorBuyMinTokensOut: 0,
                deadline: vm.getBlockTimestamp() + 1 days
            }),
            Constants.MODE_PVE
        );
        c = BondingCurve(r.curve);
        t = Token(r.token);
    }

    function _run(bool burn) internal returns (uint256 sold, uint256 lpTokens, bool grad, uint256 aliceClaim) {
        (BondingCurve c, Token t) = _easy();
        vm.warp(vm.getBlockTimestamp() + 61);
        _buyQ(c, alice, 1_000 ether);
        _buyQ(c, bob, 1_000 ether);
        _buyQ(c, carol, 30 ether);
        for (uint256 i; i < 200 && c.marketCapUsd() < 25_000e18; ++i) {
            _buyQ(c, makeAddr(string(abi.encodePacked("pump", vm.toString(i)))), 200 ether);
        }
        // bob takes profit: crew tip accrues to everyone else's NET (alice included)
        _sellT(c, t, bob, t.balanceOf(bob));
        uint256 pendA = c.pendingRewards(alice);
        uint256 tn0 = c.totalNet();
        uint256 s0 = c.tokensSold();
        if (burn) {
            uint256 half = t.balanceOf(alice) / 2;
            uint256 netA = c.balanceOnCurve(alice);
            vm.prank(alice);
            t.burn(half);
            assertEq(c.tokensSold(), s0, "burn does not move the curve");
            assertEq(c.totalNet(), tn0 - (half < netA ? half : netA), "totalNet drops by the burned NET");
            assertEq(c.pendingRewards(alice), pendA, "burner's accrued rewards kept");
        }
        // a later profit-taker: tip now split over the smaller totalNet
        _sellT(c, t, carol, t.balanceOf(carol));
        sold = c.tokensSold();
        _graduate(c);
        grad = c.graduated();
        lpTokens = t.balanceOf(address(c));
        // every holder claims; the curve must stay solvent
        uint256 qb = IERC20(address(quote)).balanceOf(address(c));
        address[3] memory hs = [alice, bob, carol];
        uint256 paid;
        for (uint256 i; i < 3; ++i) {
            uint256 p = c.pendingRewards(hs[i]);
            if (p != 0) {
                vm.prank(hs[i]);
                paid += c.claim();
                if (hs[i] == alice) aliceClaim = p;
            }
        }
        assertLe(paid, qb, "claims covered by the curve's quote");
        console2.log("burn?", burn);
        console2.log("tokensSold before graduation", sold);
        console2.log("curve token balance after graduation", lpTokens);
        console2.log("alice claim", aliceClaim);
        console2.log("token totalSupply", t.totalSupply());
    }

    function test_easyBurn_realCurve() public {
        uint256 snap = vm.snapshotState();
        (uint256 s0,, bool g0, uint256 a0) = _run(false);
        vm.revertToState(snap);
        (uint256 s1,, bool g1, uint256 a1) = _run(true);
        assertTrue(g0 && g1, "both graduate");
        assertEq(s0, s1, "same curve state either way");
        assertLt(a1, a0, "burner earns less of later tips (smaller NET)");
    }

    /// Audit delta I-01 (accepted behaviour, documented): the Easy holding cap is an instantaneous cap. Buy to the
    /// cap, burn, and the burned NET frees cap room, so one wallet can buy again. tokensSold never goes down.
    function test_easyBurn_capRoomReturnsAfterBurn() public {
        (BondingCurve c, Token t) = _easy();
        vm.warp(vm.getBlockTimestamp() + 61);
        uint256 bought;
        uint256 s0 = c.tokensSold();
        for (uint256 r; r < 3; ++r) {
            uint256 b0 = t.balanceOf(alice);
            _buyQ(c, alice, 5_000 ether); // far over the cap: partial-fills to it
            uint256 got = t.balanceOf(alice) - b0;
            // partial fill stops at the cap as of the fill (the cap rises with tokensSold, so allow 1%)
            assertApproxEqRel(c.balanceOnCurve(alice), c.netCapNow(), 0.01e18, "filled to the cap");
            bought += got;
            uint256 bal = t.balanceOf(alice);
            vm.prank(alice);
            t.burn(bal);
            assertEq(c.balanceOnCurve(alice), 0, "burn frees the cap room");
        }
        assertGt(bought, 2 * c.netCapNow(), "cumulative buys exceed the instantaneous cap");
        assertEq(c.tokensSold() - s0, bought, "burned tokens stay sold on the curve");
        assertFalse(c.graduated());
    }
}

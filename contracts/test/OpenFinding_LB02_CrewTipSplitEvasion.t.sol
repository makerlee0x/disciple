// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

// LB-02: the Easy (PVE) crew tip is decided PER SALE (profit of this sale > 0.5% of mcap). Splitting one profitable
// exit into several smaller sells pays no tip at all and nets more than the single sale.
// Place in contracts/test/ and run: forge test --match-contract LB02_CrewTipSplitEvasion -vv

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {Token} from "../src/Token.sol";
import {LoginGate} from "../src/LoginGate.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {Constants} from "../src/libraries/Constants.sol";

contract LB02_CrewTipSplitEvasion is IntegrationBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        LoginGate gate = new LoginGate(owner, vm.addr(0xA77E57));
        vm.prank(owner);
        launchpad.setLoginGate(address(gate)); // required to launch PVE; lp-accrue curves never read it
        quote.mint(alice, 10_000_000 ether);
        quote.mint(bob, 10_000_000 ether);
    }

    function _buyQ(BondingCurve c, address w, uint256 q) internal {
        vm.startPrank(w);
        quote.approve(address(c), q);
        c.buy(q, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function _sellT(BondingCurve c, Token t, address w, uint256 n) internal returns (uint256 out) {
        vm.startPrank(w);
        t.approve(address(c), n);
        out = c.sell(n, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
    }

    function test_splitSellPaysNoCrewTip() public {
        vm.prank(creator);
        ILaunchpad.LaunchResult memory r = launchpad.launchWithMode(
            ILaunchpad.LaunchParams({
                name: "Easy",
                ticker: "E",
                imageURI: "ipfs://img",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: vm.getBlockTimestamp() + 1 days
            }),
            Constants.MODE_PVE
        );
        BondingCurve c = BondingCurve(r.curve);
        Token t = Token(r.token);

        vm.warp(vm.getBlockTimestamp() + 61);
        _buyQ(c, alice, 1_000 ether); // fills to the 1% cap at ~$3.3K mcap
        _buyQ(c, bob, 30 ether); // another holder, so the tip goes to the pool (not treasury)
        for (uint256 i; i < 200 && c.marketCapUsd() < 25_000e18; ++i) {
            address w = makeAddr(string(abi.encodePacked("pump", vm.toString(i))));
            quote.mint(w, 1_000 ether);
            _buyQ(c, w, 200 ether);
        }

        uint256 bal = t.balanceOf(alice);
        uint256 held0 = c.rewardsHeld();
        uint256 snap = vm.snapshotState();

        // (a) one sale: tipped
        uint256 tipOne = c.quoteSellFor(alice, bal).profitTax;
        assertGt(tipOne, 0, "whole exit is above the threshold");
        uint256 outOne = _sellT(c, t, alice, bal);
        assertEq(c.rewardsHeld() - held0, tipOne, "tip paid to holders");
        vm.revertToState(snap);

        // (b) same exit, split so that each sale's profit stays <= threshold: no tip
        uint256 outSplit;
        uint256 left = bal;
        uint256 chunk = bal / 2;
        uint256 sells;
        while (left > 0) {
            if (chunk > left) chunk = left;
            while (c.quoteSellFor(alice, chunk).profitTax != 0) chunk /= 2;
            require(chunk > 0, "chunk");
            outSplit += _sellT(c, t, alice, chunk);
            left -= chunk;
            ++sells;
        }
        emit log_named_uint("sells needed", sells);
        emit log_named_decimal_uint("tip avoided", tipOne, 18);
        assertEq(c.rewardsHeld(), held0, "no crew tip charged on any split sale");
        assertGt(outSplit, outOne, "splitting nets more than the single sale");
    }
}

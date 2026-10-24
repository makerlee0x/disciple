// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Phase 3a: FeeRouter.referralSink redirects the 1% referral share (future trades only).
contract ReferralSinkTest is IntegrationBase {
    event ReferralSinkSet(address indexed previous, address indexed sink);

    address sink = makeAddr("referralSink");
    uint256 constant BUY = 100 ether;
    uint256 constant REF = 0.01 ether; // 1% of the 1% fee on 100 USDG

    function _sink(address s) internal {
        vm.prank(owner);
        feeRouter.setReferralSink(s);
    }

    function test_default_off_keeps_referrer_routing() public {
        assertEq(feeRouter.referralSink(), address(0));
        _bindReferral(referred, kol, 10 ether);
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        _buy(c, referred, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), REF);
    }

    function test_only_owner_and_event() public {
        vm.prank(trader1);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        feeRouter.setReferralSink(sink);
        vm.expectEmit(address(feeRouter));
        emit ReferralSinkSet(address(0), sink);
        _sink(sink);
        assertEq(feeRouter.referralSink(), sink);
        vm.expectEmit(address(feeRouter));
        emit ReferralSinkSet(sink, address(0));
        _sink(address(0));
    }

    function test_sink_gets_future_referral_share_past_accruals_stay_claimable() public {
        _bindReferral(referred, kol, 10 ether);
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        _buy(c, referred, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), REF);
        _sink(sink);
        uint256 t0 = feeRouter.treasuryAccrued(address(quote));
        _buy(c, referred, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), REF, "referrer: no new accrual");
        assertEq(feeRouter.referrerAccrued(sink, address(quote)), REF, "sink accrues the 1%");
        assertEq(feeRouter.treasuryAccrued(address(quote)) - t0, 0.33 ether, "treasury unchanged (33%)");
        // both claim
        vm.prank(kol);
        assertEq(feeRouter.claimReferrerFees(address(quote)), REF);
        uint256 b = quote.balanceOf(sink);
        vm.prank(sink);
        feeRouter.claimReferrerFees(address(quote));
        assertEq(quote.balanceOf(sink) - b, REF);
    }

    function test_sink_is_treasury_credits_treasuryAccrued() public {
        _bindReferral(referred, kol, 10 ether);
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        _sink(feeRouter.treasury());
        uint256 t0 = feeRouter.treasuryAccrued(address(quote));
        _buy(c, referred, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), 0);
        assertEq(feeRouter.referrerAccrued(feeRouter.treasury(), address(quote)), 0, "not as a referrer balance");
        assertEq(feeRouter.treasuryAccrued(address(quote)) - t0, 0.33 ether + REF, "33% + the 1%");
    }

    function test_no_referrer_still_treasury() public {
        (BondingCurve c,) = _launch(0, 0);
        _warpPastSnipe();
        _sink(sink);
        uint256 t0 = feeRouter.treasuryAccrued(address(quote));
        _buy(c, trader2, BUY, 0); // trader2 has no referrer
        assertEq(feeRouter.referrerAccrued(sink, address(quote)), 0, "sink only replaces a referrer");
        assertEq(feeRouter.treasuryAccrued(address(quote)) - t0, 0.33 ether + REF);
    }

    /// @dev Launch-KOL coins: the 1% leftover is the same referral share → redirected; the KOL's 2% of the
    ///      creator's 33% is a separate cut → unchanged.
    function test_launch_kol_one_pct_redirected_two_pct_creator_cut_kept() public {
        _bindReferral(referred, kol, 10 ether);
        vm.startPrank(referred);
        ILaunchpad.LaunchResult memory r = launchpad.launch(
            ILaunchpad.LaunchParams({
                name: "RefCoin",
                ticker: "REF",
                imageURI: "ipfs://r",
                description: "",
                socialsURI: "",
                quote: address(quote),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: block.timestamp + 1 hours
            })
        );
        vm.stopPrank();
        assertEq(feeRouter.tokenLaunchKol(r.token), kol);
        _sink(sink);
        _warpPastSnipe();
        _buy(BondingCurve(r.curve), trader1, BUY, 0);
        uint256 creatorRaw = 0.33 ether;
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), creatorRaw * 200 / 10_000, "KOL keeps 2% of creator");
        assertEq(feeRouter.referrerAccrued(sink, address(quote)), REF, "sink gets the 1%");
    }
}

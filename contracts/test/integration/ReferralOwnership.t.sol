// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "./IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Constants} from "../../src/libraries/Constants.sol";
import {ReferralRegistry} from "../../src/ReferralRegistry.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Referral / KOL / ownership / claim integration coverage.
contract ReferralOwnershipIntegrationTest is IntegrationBase {
    function test_referral_firstTouch_usdgGate_and_lifetime_1pct() public {
        // Attribute pending then deposit ≥ $10
        _bindReferral(referred, kol, 10 * U);
        assertEq(referrals.referrerOf(referred), kol);

        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();

        uint256 refBefore = feeVault.referrerAccrued(kol, address(quote));
        _buy(curve, referred, 100 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault
        uint256 refAfter = feeVault.referrerAccrued(kol, address(quote));
        assertGt(refAfter, refBefore, "KOL gets 1% of trade fee leftover");

        // Claim anytime
        uint256 claimable = feeVault.referrerAccrued(kol, address(quote));
        uint256 bal0 = quote.balanceOf(kol);
        vm.prank(kol);
        feeVault.claimReferrerFees(address(quote), new address[](0));
        assertEq(feeVault.referrerAccrued(kol, address(quote)), 0);
        assertEq(quote.balanceOf(kol), bal0 + claimable);
        tok;
    }

    function test_selfReferral_blocked() public {
        vm.prank(kol);
        vm.expectRevert(ReferralRegistry.SelfReferral.selector);
        referrals.tryAttribute(kol, kol);
    }

    function test_referral_notFinal_without_usdgGate() public {
        vm.prank(trader1);
        referrals.tryAttribute(trader1, kol);
        assertEq(referrals.referrerOf(trader1), address(0));
        assertEq(referrals.pendingReferrer(trader1), kol);
        // Deposit $9.99 — still under gate
        depositHook.notifyDeposit(trader1, 9 * U);
        assertEq(referrals.referrerOf(trader1), address(0));
        depositHook.notifyDeposit(trader1, 1 * U);
        assertEq(referrals.referrerOf(trader1), kol);
    }

    function test_treasury_autoPush_on_trade() public {
        (BondingCurve curve,) = _launch(0, 0);
        _warpPastSnipe();
        uint256 tre0 = (quote.balanceOf(treasury) + feeVault.treasuryAccrued(address(quote)));
        _buy(curve, trader1, 100 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault
        assertGt((quote.balanceOf(treasury) + feeVault.treasuryAccrued(address(quote))), tre0, "treasury auto-push");
    }

    function test_creator_claim_anytime() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        _buy(curve, trader1, 100 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault
        uint256 accrued = feeVault.creatorAccrued(address(tok), creator);
        assertGt(accrued, 0);
        uint256 bal0 = quote.balanceOf(creator);
        vm.prank(creator);
        feeVault.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(creator) - bal0, accrued);
        assertEq(feeVault.creatorAccrued(address(tok), creator), 0);
        curve;
    }

    function test_ownership_transfer_updates_metadata_rights_multiHop() public {
        (, Token tok) = _launch(0, 0);
        address hop1 = makeAddr("hop1");
        address hop2 = makeAddr("hop2");

        vm.prank(creator);
        launchpad.transferCreator(address(tok), hop1);
        vm.prank(hop1);
        launchpad.updateMetadata(address(tok), "ipfs://new", "d", "");

        vm.prank(hop1);
        launchpad.transferCreator(address(tok), hop2);
        vm.prank(hop2);
        launchpad.updateMetadata(address(tok), "ipfs://new2", "d2", "s");

        // Old creator cannot update
        vm.prank(creator);
        vm.expectRevert();
        launchpad.updateMetadata(address(tok), "x", "y", "z");
    }

    /// @notice Ownership pack: fee claim + tax rights follow Launchpad.creatorOf (multi-hop).
    ///         Accrued-before-transfer stays with the previous creator.
    function test_ownership_transfer_moves_fee_claim_and_tax_rights() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();

        // Accrue some fees to original creator first
        _buy(curve, trader1, 40 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault
        uint256 oldAccrued = feeVault.creatorAccrued(address(tok), creator);
        assertGt(oldAccrued, 0, "pre-transfer accrual");

        address hop1 = makeAddr("hop1");
        address hop2 = makeAddr("hop2");
        vm.prank(creator);
        launchpad.transferCreator(address(tok), hop1);
        assertEq(launchpad.creatorOf(address(tok)), hop1);

        // Post-transfer fees → hop1; old accrual unchanged under creator
        _buy(curve, trader2, 50 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault
        assertEq(feeVault.creatorAccrued(address(tok), creator), oldAccrued, "pre-transfer accrual stays with old");
        assertGt(feeVault.creatorAccrued(address(tok), hop1), 0, "new creator accrues after transfer");

        // Multi-hop
        vm.prank(hop1);
        launchpad.transferCreator(address(tok), hop2);
        uint256 hop1Accrued = feeVault.creatorAccrued(address(tok), hop1);
        _buy(curve, sniper, 30 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault
        assertEq(feeVault.creatorAccrued(address(tok), hop1), hop1Accrued, "hop1 pre-transfer stays");
        assertGt(feeVault.creatorAccrued(address(tok), hop2), 0, "hop2 accrues");

        // Claims work for each owner of their own accrual
        uint256 bal0 = quote.balanceOf(creator);
        vm.prank(creator);
        feeVault.claimCreatorFees(address(tok));
        assertEq(quote.balanceOf(creator), bal0 + oldAccrued);
    }

    /// @notice L1 (lee, Nov 9 2026: "Leave it, the new creator gets unsettled fees."): fees still owed on the curve at a
    ///         creatorship transfer are booked to the creator of record at settle time; settling first keeps them.
    function test_ownership_transfer_unsettled_fees_follow_new_creator() public {
        (BondingCurve curve, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        address hop1 = makeAddr("hop1");
        _buy(curve, trader1, 40 * U, 0); // unreferred: owed on the curve, not settled
        uint256 owed = feeVault.creatorClaimable(address(tok), creator);
        assertGt(owed, 0);
        vm.prank(creator);
        launchpad.transferCreator(address(tok), hop1);
        assertEq(feeVault.creatorClaimable(address(tok), creator), 0, "old creator: nothing booked");
        assertEq(feeVault.creatorClaimable(address(tok), hop1), owed, "unsettled fees follow the new creator");
        curve.settleFees();
        assertEq(feeVault.creatorAccrued(address(tok), hop1), owed);
        assertEq(feeVault.creatorAccrued(address(tok), creator), 0);
    }

    /// @notice LOCKED #21: coins created by referred wallet → KOL gets leftover 1% + 2% of creator's 33%.
    function test_kol_on_creates_gets_1pct_leftover_plus_2pct_of_creator_share() public {
        _bindReferral(referred, kol, 10 * U);
        assertEq(referrals.referrerOf(referred), kol);

        uint256 ts = block.timestamp;
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
                deadline: ts + 1 hours
            })
        );
        vm.stopPrank();
        assertEq(feeRouter.tokenLaunchKol(r.token), kol);

        BondingCurve curve = BondingCurve(r.curve);
        _warpPastSnipe();
        _buy(curve, trader1, 100 * U, 0); curve.settleFees(); // lp-accrue: settle into CurveFeeVault

        uint256 creatorFees = feeVault.creatorAccrued(r.token, referred);
        uint256 kolShare = feeVault.referrerAccrued(kol, address(quote));
        assertGt(creatorFees, 0);
        assertGt(kolShare, 0, "KOL must get leftover 1% + 2% of creator share");

        // protoFee = 1% of 100e18 = 1e18
        // creatorShare raw = 33% = 0.33e18; kol takes 2% of that = 0.0066e18; leftover 1% = 0.01e18
        // expected kol ≈ 0.0166e18
        uint256 proto = 1 * U; // 1% of 100 * U
        uint256 creatorRaw = (proto * 33) / 100;
        uint256 expectedKol = (proto * 1) / 100 + (creatorRaw * 200) / 10_000;
        assertEq(kolShare, expectedKol);
        assertEq(creatorFees, creatorRaw - (creatorRaw * 200) / 10_000);
    }
}

/// @notice 6-decimal USDG run of ReferralOwnershipIntegrationTest (mainnet USDG / next testnet mock); same tests, `U` = 1e6.
contract ReferralOwnershipIntegration6DecTest is ReferralOwnershipIntegrationTest {
    function _usdgDecimals() internal pure override returns (uint8) {
        return 6;
    }
}

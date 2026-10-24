// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Redeploy pack item 7: owner-settable launch-KOL cut of the creator share (default 200 bps, 0–500).
contract KolCreatorShareTest is IntegrationBase {
    event KolCreatorShareSet(uint256 previousBps, uint256 bps);

    uint256 constant BUY = 100 ether;
    uint256 constant CREATOR_RAW = 0.33 ether; // 33% of the 1% fee on 100 USDG
    uint256 constant REF = 0.01 ether; // the 1% leftover

    function _launchReferred() internal returns (BondingCurve) {
        _bindReferral(referred, kol, 10 ether);
        vm.prank(referred);
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
        assertEq(feeRouter.tokenLaunchKol(r.token), kol);
        _warpPastSnipe();
        return BondingCurve(r.curve);
    }

    function _set(uint256 bps) internal {
        vm.prank(owner);
        feeRouter.setKolCreatorShareBps(bps);
    }

    function test_default_is_200_and_matches_old_constant() public {
        assertEq(feeRouter.kolCreatorShareBps(), 200);
        assertEq(feeRouter.MAX_KOL_CREATOR_SHARE_BPS(), 500);
        BondingCurve c = _launchReferred();
        _buy(c, trader1, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), REF + CREATOR_RAW * 200 / 10_000);
    }

    function test_onlyOwner_range_event() public {
        vm.prank(trader1);
        vm.expectRevert(Owned2Step.OnlyOwner.selector);
        feeRouter.setKolCreatorShareBps(100);
        vm.prank(owner);
        vm.expectRevert(FeeRouter.KolShareTooHigh.selector);
        feeRouter.setKolCreatorShareBps(501);
        vm.expectEmit(address(feeRouter));
        emit KolCreatorShareSet(200, 500);
        _set(500);
        assertEq(feeRouter.kolCreatorShareBps(), 500);
        vm.expectEmit(address(feeRouter));
        emit KolCreatorShareSet(500, 0);
        _set(0);
        assertEq(feeRouter.kolCreatorShareBps(), 0);
    }

    function test_future_trades_only_past_accruals_unchanged() public {
        BondingCurve c = _launchReferred();
        _buy(c, trader1, BUY, 0);
        uint256 k1 = feeRouter.referrerAccrued(kol, address(quote));
        uint256 cr1 = feeRouter.creatorAccrued(address(c.token()), referred);
        assertEq(k1, REF + CREATOR_RAW * 200 / 10_000);
        assertEq(cr1, CREATOR_RAW - CREATOR_RAW * 200 / 10_000);

        _set(500);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), k1, "setter does not touch accruals");
        _buy(c, trader1, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)) - k1, REF + CREATOR_RAW * 500 / 10_000);
        assertEq(
            feeRouter.creatorAccrued(address(c.token()), referred) - cr1, CREATOR_RAW - CREATOR_RAW * 500 / 10_000
        );

        _set(0);
        uint256 k2 = feeRouter.referrerAccrued(kol, address(quote));
        uint256 cr2 = feeRouter.creatorAccrued(address(c.token()), referred);
        _buy(c, trader1, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)) - k2, REF, "0 bps: KOL keeps only the 1% leftover");
        assertEq(feeRouter.creatorAccrued(address(c.token()), referred) - cr2, CREATOR_RAW, "creator keeps all 33%");
    }

    function test_referralSink_logic_unchanged() public {
        address sink = makeAddr("sink");
        vm.prank(owner);
        feeRouter.setReferralSink(sink);
        _set(300);
        BondingCurve c = _launchReferred();
        _buy(c, trader1, BUY, 0);
        assertEq(feeRouter.referrerAccrued(sink, address(quote)), REF, "sink still gets the 1%");
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), CREATOR_RAW * 300 / 10_000, "KOL cut not redirected");
        assertEq(feeRouter.referralSink(), sink, "packed slot keeps the sink");
    }

    function test_no_launch_kol_no_cut() public {
        _set(500);
        _bindReferral(referred, kol, 10 ether);
        (BondingCurve c,) = _launch(0, 0); // launched by `creator` (no referrer)
        _warpPastSnipe();
        _buy(c, referred, BUY, 0); // trader's referrer gets the 1% only
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), REF);
    }

    function testFuzz_kolCut(uint16 bps) public {
        uint256 b = bound(bps, 0, 500);
        _set(b);
        BondingCurve c = _launchReferred();
        _buy(c, trader1, BUY, 0);
        assertEq(feeRouter.referrerAccrued(kol, address(quote)), REF + CREATOR_RAW * b / 10_000);
    }
}

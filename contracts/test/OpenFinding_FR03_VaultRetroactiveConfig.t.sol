// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {Token} from "../src/Token.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";

/// FR-03: lp-accrue owed fees are split with the FeeRouter config read at SETTLE time, so a kolCreatorShareBps or
/// referralSink change applies retroactively to every unsettled curve fee (FeeRouter docs: "future trades only").
contract FR03_VaultRetroactiveConfig is IntegrationBase {
    function test_FR03_kolBpsChange_appliesToOwedFees() public {
        _bindReferral(creator, kol, 100 * U); // creator referred => launch KOL coin
        (BondingCurve curve, Token tok) = _launch(0, 0);
        tok;
        _warpPastSnipe();
        address w = makeAddr("w");
        quote.mint(w, 1_000 * U);
        _buy(curve, w, 100 * U, 0); // unreferred trade at kolCreatorShareBps = 200
        uint256 owed = curve.protoFeesOwed();
        (uint256 cs,,, uint256 rf) = FeeMath.splitTradeFee(owed);

        vm.prank(owner);
        feeRouter.setKolCreatorShareBps(500); // "future trades only"
        curve.settleFees();

        assertEq(feeVault.referrerAccrued(kol, address(quote)), rf + cs * 500 / 10_000, "KOL got the NEW 5% on old fees");
    }

    function test_FR03_sinkChange_appliesToOwedFees() public {
        _bindReferral(creator, kol, 100 * U);
        (BondingCurve curve,) = _launch(0, 0);
        _warpPastSnipe();
        address w = makeAddr("w");
        quote.mint(w, 1_000 * U);
        _buy(curve, w, 100 * U, 0);
        (,,, uint256 rf) = FeeMath.splitTradeFee(curve.protoFeesOwed());
        address sink = makeAddr("sink");
        vm.prank(owner);
        feeRouter.setReferralSink(sink);
        curve.settleFees();
        assertEq(feeVault.referrerAccrued(sink, address(quote)), rf, "sink took the 1% of trades made before it was set");
    }
}

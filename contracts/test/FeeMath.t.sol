// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";

/// @notice Smoke tests for constitution fee / supply constants (§3, §2).
contract FeeMathTest is Test {
    function test_tradeFeeBps_is1Percent() public pure {
        assertEq(Constants.TRADE_FEE_BPS, 100);
    }

    function test_feeShares_sumTo100() public pure {
        assertEq(
            Constants.FEE_SHARE_CREATOR + Constants.FEE_SHARE_LP_LOCK + Constants.FEE_SHARE_TREASURY
                + Constants.FEE_SHARE_REFERRAL,
            Constants.FEE_SHARE_DENOM
        );
        assertEq(Constants.FEE_SHARE_CREATOR, 33);
        assertEq(Constants.FEE_SHARE_LP_LOCK, 33);
        assertEq(Constants.FEE_SHARE_TREASURY, 33);
        assertEq(Constants.FEE_SHARE_REFERRAL, 1);
    }

    function test_splitTradeFee_33_33_33_1() public pure {
        uint256 fee = 10_000 ether;
        (uint256 c, uint256 lp, uint256 t, uint256 r) = FeeMath.splitTradeFee(fee);
        assertEq(c, 3300 ether);
        assertEq(lp, 3300 ether);
        assertEq(t, 3300 ether);
        assertEq(r, 100 ether);
        assertEq(c + lp + t + r, fee);
    }

    function test_protocolFee_1pct() public pure {
        assertEq(FeeMath.protocolFee(1_000_000), 10_000);
    }

    function test_creatorTax_max7pct() public pure {
        assertEq(Constants.CREATOR_TAX_MAX_BPS, 700);
        assertEq(FeeMath.creatorTax(1_000_000, 700), 70_000);
    }

    function test_creatorTax_revertsAboveMax() public {
        vm.expectRevert(bytes("FeeMath: tax > max"));
        this.externalCreatorTax(1_000_000, 701);
    }

    function externalCreatorTax(uint256 n, uint256 bps) external pure returns (uint256) {
        return FeeMath.creatorTax(n, bps);
    }

    function test_totalSupply_1M() public pure {
        assertEq(Constants.TOTAL_SUPPLY, 1_000_000 * 1e18);
        assertEq(Constants.TOKEN_DECIMALS, 18);
    }

    function test_walletCap_7pct() public pure {
        assertEq(FeeMath.walletCap(), (Constants.TOTAL_SUPPLY * 700) / 10_000);
    }

    function test_curveSold_8424bps() public pure {
        assertEq(FeeMath.curveSoldSupply(), (Constants.TOTAL_SUPPLY * 8424) / 10_000);
    }

    function test_outerSpace_33333() public pure {
        assertEq(Constants.GRADUATION_MCAP_USD, 33_333 * 1e18);
        assertEq(Constants.OUTER_SPACE_MCAP_USD, Constants.GRADUATION_MCAP_USD);
        assertEq(Constants.START_MCAP_USD, 3_333 * 1e18);
        assertEq(Constants.CURVE_MID_MCAP_USD, 15_000 * 1e18);
    }

    function test_antiSnipe_constants() public pure {
        assertEq(Constants.ANTI_SNIPE_START_BPS, 9900);
        assertEq(Constants.ANTI_SNIPE_END_BPS, 0);
        assertEq(Constants.ANTI_SNIPE_DURATION, 7);
        assertEq(Constants.SNIPE_ESCROW_TIMEOUT, 30 days);
    }

    /// lee 2026-10-24: 7s window, fast per-second decay (≈ Pons V2), hard 0 from 7s.
    function test_snipeBps_schedule() public pure {
        uint256[8] memory want = [uint256(9900), 2500, 300, 100, 30, 10, 3, 0];
        for (uint256 e; e < 8; ++e) assertEq(FeeMath.snipeBps(e), want[e]);
        assertEq(FeeMath.snipeBps(0), Constants.ANTI_SNIPE_START_BPS);
        assertEq(FeeMath.snipeBps(Constants.ANTI_SNIPE_DURATION), 0);
        assertEq(FeeMath.snipeBps(77), 0);
        assertEq(FeeMath.snipeBps(type(uint64).max), 0);
        for (uint256 e = 1; e < 8; ++e) assertLt(FeeMath.snipeBps(e), FeeMath.snipeBps(e - 1)); // strictly decreasing
    }

    function test_creatorBuyMax_0_77pct() public pure {
        assertEq(Constants.CREATOR_BUY_MAX_BPS_DEFAULT, 77);
        assertEq(Constants.CREATOR_BUY_MAX_BPS_CEILING, 700);
        assertEq(FeeMath.creatorBuyMax(), (Constants.TOTAL_SUPPLY * 77) / 10_000);
    }

    function test_referralGate_10USDG() public pure {
        assertEq(Constants.REFERRAL_GATE_USD, 10);
    }
}

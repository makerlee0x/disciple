// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {McapMath} from "../src/libraries/McapMath.sol";
import {SqrtPrice} from "../src/libraries/SqrtPrice.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice mcap precision for 6- and 18-decimal quotes (quotePriceUsd = USD WAD per 1e18 raw quote).
contract McapPrecisionTest is Test {
    uint256 constant USD6 = 1e30; // $1 per 1e6 raw → 1e30 USD-WAD per 1e18 raw
    uint256 constant USD18 = 1e18;

    function _legacyMcap(CurveMath.Params memory p, uint256 s) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(CurveMath.spotPriceWad(p, s), p.totalSupply, 1e18), p.quotePriceUsd, 1e18);
    }

    function _assertNear(uint256 a, uint256 b, uint256 bps) internal pure {
        assertApproxEqRel(a, b, bps * 1e14);
    }

    function test_curve_mcap_6dec_graduation_is_33k() public pure {
        CurveMath.Params memory p = CurveMath.makeParams(USD6);
        uint256 m = CurveMath.marketCapUsd(p, p.sCurve);
        _assertNear(m, Constants.GRADUATION_MCAP_USD, 1); // within 0.01%
        // the old floored path was materially low with 7B supply (the $28K bug); at 1M supply the WAD price is
        // ~33,333 so even the floored path is within 0.01% (full-precision path kept regardless)
        assertApproxEqRel(_legacyMcap(p, p.sCurve), Constants.GRADUATION_MCAP_USD, 0.0001e18);
        _assertNear(CurveMath.marketCapUsd(p, 0), Constants.START_MCAP_USD, 1);
    }

    function test_curve_mcap_18dec_unchanged() public pure {
        CurveMath.Params memory p = CurveMath.makeParams(USD18);
        _assertNear(CurveMath.marketCapUsd(p, p.sCurve), Constants.GRADUATION_MCAP_USD, 1);
        _assertNear(CurveMath.marketCapUsd(p, 0), Constants.START_MCAP_USD, 1);
        // for 18-dec the legacy and new paths agree to ~1e-12
        uint256 s = p.sCurve / 3;
        _assertNear(CurveMath.marketCapUsd(p, s), _legacyMcap(p, s), 1);
    }

    function test_marketCapQuote_6dec_raw_units() public pure {
        CurveMath.Params memory p = CurveMath.makeParams(USD6);
        // $33,333 at $1 → 33_333e6 raw
        _assertNear(CurveMath.marketCapQuote(p, p.sCurve), 33_333e6, 1);
    }

    function _sqrtMcapCase(uint256 quoteUsd, uint256 decScale, bool tokenIsC0) internal pure {
        CurveMath.Params memory p = CurveMath.makeParams(quoteUsd);
        uint256 x = CurveMath.virtualQuote(p, p.sCurve);
        uint256 y = CurveMath.virtualToken(p, p.sCurve);
        uint160 sp = SqrtPrice.fromReserves(x, y, tokenIsC0);
        uint256 mq = McapMath.mcapQuoteFromSqrt(sp, tokenIsC0, Constants.TOTAL_SUPPLY);
        _assertNear(mq, 33_333 * decScale, 1);
        _assertNear(McapMath.mcapUsdFromSqrt(sp, tokenIsC0, Constants.TOTAL_SUPPLY, quoteUsd), 33_333e18, 1);
    }

    function test_sqrt_mcap_6dec_both_orderings() public pure {
        _sqrtMcapCase(USD6, 1e6, true);
        _sqrtMcapCase(USD6, 1e6, false);
    }

    function test_sqrt_mcap_18dec_both_orderings() public pure {
        _sqrtMcapCase(USD18, 1e18, true);
        _sqrtMcapCase(USD18, 1e18, false);
    }

    function testFuzz_sqrt_mcap_matches_reserves(uint256 s, bool c0) public pure {
        CurveMath.Params memory p = CurveMath.makeParams(USD6);
        s = bound(s, 0, p.sCurve);
        uint160 sp = SqrtPrice.fromReserves(CurveMath.virtualQuote(p, s), CurveMath.virtualToken(p, s), c0);
        _assertNear(McapMath.mcapQuoteFromSqrt(sp, c0, p.totalSupply), CurveMath.marketCapQuote(p, s), 1);
    }
}

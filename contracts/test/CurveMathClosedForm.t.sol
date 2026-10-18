// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Audit G-7: the closed-form quoteOutForTokens equals the old one-wei step-down loop exactly.
contract CurveMathClosedFormTest is Test {
    function _old(CurveMath.Params memory p, uint256 s, uint256 t) internal pure returns (uint256 q) {
        uint256 y = p.y0 - s;
        uint256 x = Math.mulDiv(p.x0, p.y0, y);
        q = Math.mulDiv(x, t, y + t);
        uint256 sAfter = s - t;
        while (q > 0 && CurveMath.tokensOutForQuote(p, sAfter, q) > t) --q;
    }

    function _check(uint256 priceSeed, uint256 sSeed, uint256 tSeed) internal pure {
        CurveMath.Params memory p = CurveMath.makeParams(bound(priceSeed, 1e15, 1e24));
        uint256 s = bound(sSeed, 1, p.sCurve - 1); // below sCurve (sells only happen pre-graduation)
        uint256 t = bound(tSeed, 1, s);
        uint256 q = CurveMath.quoteOutForTokens(p, s, t);
        assertEq(q, _old(p, s, t), "closed form == loop");
        assertLe(CurveMath.tokensOutForQuote(p, s - t, q), t, "buy-back <= tokensIn");
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_closedFormEqualsLoop(uint256 priceSeed, uint256 sSeed, uint256 tSeed) public pure {
        _check(priceSeed, sSeed, tSeed);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_closedFormSmallAmounts(uint256 priceSeed, uint256 sSeed, uint256 tSeed) public pure {
        _check(priceSeed, sSeed, bound(tSeed, 1, 1e6)); // wei-scale sells: where rounding matters most
    }
}

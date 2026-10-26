// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";

/// @notice Phase 3a: the graduating curve.buy (Migration + full-range seed + 16 floor bands, one tx) must stay
///         <= 3.0M execution gas, both token orders. Run: forge test --mc FloorSeedGas --isolate -vv
contract FloorSeedGas is IntegrationBase {
    uint256 internal constant GRAD_GAS_MAX = 3_000_000;

    function _gradMeasured(BondingCurve curve) internal returns (uint256 gGrad) {
        _warpPastSnipe();
        for (uint256 i = 0; i < 120 && !curve.graduated(); i++) {
            address w = makeAddr(string(abi.encodePacked("fgW", vm.toString(i), address(curve))));
            quote.mint(w, 50_000 ether);
            uint256[6] memory sizes = [uint256(400 ether), 200 ether, 100 ether, 50 ether, 10 ether, 1 ether];
            for (uint256 j = 0; j < sizes.length && !curve.graduated(); j++) {
                vm.prank(w);
                quote.approve(address(curve), sizes[j]);
                vm.prank(w);
                try curve.buy(sizes[j], 0, block.timestamp + 1) {
                    uint256 g = vm.lastCallGas().gasTotalUsed; // read before any other call
                    if (curve.graduated()) gGrad = g;
                    break;
                } catch {}
            }
        }
        require(curve.graduated(), "not graduated");
    }

    function _run(bool wantC0) internal {
        for (uint256 i; i < 24; ++i) {
            (BondingCurve curve, Token tok) = _launch(0, 0);
            if ((uint160(address(tok)) < uint160(address(quote))) != wantC0) continue;
            uint256 g = _gradMeasured(curve);
            (, uint8 n,) = lockedLP.floorInfo(address(tok));
            assertEq(n, 16, "16 bands");
            console2.log(wantC0 ? "token=currency0" : "token=currency1", "graduating buy gas (16 bands)", g);
            vm.snapshotValue("floor", wantC0 ? "graduating.buy.tokenC0" : "graduating.buy.tokenC1", g);
            assertLe(g, GRAD_GAS_MAX, "graduating buy <= 3.0M");
            return;
        }
        revert("order not found");
    }

    function test_gradGas_16bands_tokenC0() public {
        _run(true);
    }

    function test_gradGas_16bands_tokenC1() public {
        _run(false);
    }
}

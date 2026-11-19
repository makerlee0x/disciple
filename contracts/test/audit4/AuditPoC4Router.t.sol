// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DiscipleRouter} from "../../src/DiscipleRouter.sol";
import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {Token} from "../../src/Token.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Stand-in registry the DiscipleRouter owner can install with setUsdgRouting(usdg, registry).
contract EvilRegistry {
    address public immutable curve;

    constructor(address c) {
        curve = c;
    }

    function curveOf(address) external view returns (address) {
        return curve;
    }
}

/// "Curve" that keeps whatever the router sends and reports any tokensOut the router asks for.
contract EvilCurve {
    address public immutable quote;

    constructor(address q) {
        quote = q;
    }

    function graduated() external pure returns (bool) {
        return false;
    }

    function routerBuy(address, uint256, uint256 minTokensOut, uint256, uint256) external pure returns (uint256, uint256) {
        return (minTokensOut, 0);
    }

    function routerSell(address, uint256, uint256, uint256, address, uint256) external pure returns (uint256) {
        return type(uint128).max;
    }
}

/// B-2: DiscipleRouter.setUsdgRouting re-points `launchpad` (and `usdg`) at any time, and the router trusts the
/// registry's curve for both custody and the reported amount out. The owner can take every in-flight router trade.
contract AuditPoC4Router is IntegrationBase {
    function test_B2_routerOwnerRepointsLaunchpad_takesTrades() public {
        router.setUsdgRouting(address(quote), address(launchpad)); // normal wiring (USDG = quote here)
        (BondingCurve c, Token tok) = _launch(0, 0);
        _warpPastSnipe();
        address alice = makeAddr("alice");
        quote.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        IERC20(address(quote)).approve(address(router), type(uint256).max);
        IERC20(address(tok)).approve(address(router), type(uint256).max);
        uint256 got = router.buyWithUsdg(address(tok), 100 ether, 1, block.timestamp);
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(tok.balanceOf(alice), got, "honest buy delivered tokens");

        // Fixed: the USDG routing is set once. The Team cannot re-point the registry at a fake curve.
        EvilCurve evil = new EvilCurve(address(quote));
        vm.expectRevert(DiscipleRouter.BadParam.selector);
        router.setUsdgRouting(address(quote), address(new EvilRegistry(address(evil))));
        c; // silence
    }
}

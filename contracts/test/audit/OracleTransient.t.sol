// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IntegrationBase, MockUSDG} from "../integration/IntegrationBase.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Audit F-04: move → poke → restore must not leave a transient tick credited over later time.
contract OracleTransientTest is IntegrationBase {
    function _next(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1);
    }

    function _refSwap(bool strategyIn, uint256 amt) internal {
        bool zeroForOne = strategyIn == (uint160(address(strategy)) < uint160(address(quote)));
        MockUSDG tin = strategyIn ? strategy : quote;
        tin.mint(address(this), amt);
        IERC20(address(tin)).approve(address(swapRouter), amt);
        swapRouter.swap(
            strategyUsdgKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: strategyIn ? uint160(1) << 96 : (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Audit reproduction shape: pump, poke at the peak, restore in the same tx/block, wait a full TWAP
    ///      window with no intervening poke. True spot is back at ~1; the TWAP must not keep the transient tick.
    function test_f04_movePokeRestore_doesNotPoisonTwap() public {
        _next(3600);
        pricer.poke(address(strategy));
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        assertApproxEqRel(p0, 1e18, 0.01e18, "precondition ~$1");

        _next(1); // first poke at a fresh timestamp must be AFTER the price move (audit reproduction)
        _refSwap(false, 100_000 ether); // pump
        assertGt(pricer.spotPriceUsd(address(strategy)), p0 * 3, "spot manipulated");
        pricer.poke(address(strategy)); // would formerly record the peak as the forward tick
        _refSwap(true, 100_000 ether); // restore
        assertApproxEqRel(pricer.spotPriceUsd(address(strategy)), p0, 0.05e18, "spot restored");

        _next(1800); // full default TWAP window, no keeper poke
        uint256 twap = pricer.quotePriceUsd(address(strategy));
        // Must stay near the honest ~1.0 — NOT the ~1.22 poisoned value from the audit reproduction.
        assertApproxEqRel(twap, p0, 0.05e18, "TWAP must not credit the transient poke");
        assertLt(twap, p0 * 110 / 100, "no material inflation from flash poke");

        (BondingCurve c,) = _launchWithQuote(address(0), 0, 0);
        assertApproxEqRel(c.quotePriceUsd(), p0, 0.05e18, "launch must not bake poisoned TWAP");
    }

    function test_f04_sustainedMoveTracksActualSourceHistory() public {
        _next(3600);
        pricer.poke(address(strategy));
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        _refSwap(false, 100_000 ether); // held
        pricer.poke(address(strategy)); // does not write source history
        for (uint256 i; i < 45; i++) {
            _next(60);
            pricer.poke(address(strategy)); // pokes cannot alter source history
        }
        uint256 p = pricer.quotePriceUsd(address(strategy));
        uint256 s = pricer.spotPriceUsd(address(strategy));
        assertGt(p, p0 * 110 / 100, "sustained move eventually lifts TWAP");
        assertApproxEqRel(p, s, 0.02e18, "TWAP tracks a sustained source move");
    }
    function test_f04_repeatedFlashPokesAndKeeperUpdatesDoNotAccumulate() public {
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        for (uint256 i; i < 12; ++i) {
            _next(60);
            _refSwap(false, 100_000 ether);
            pricer.poke(address(strategy));
            _refSwap(true, 100_000 ether);
            _next(60);
            pricer.poke(address(strategy)); // honest intervening keeper
        }
        _next(1800);
        assertApproxEqRel(pricer.quotePriceUsd(address(strategy)), p0, 0.001e18);
    }

    function test_f04_sourceRejectsUnauthenticatedHistoryWrites() public {
        (bool ok,) = address(strategyUsdgKey.hooks).call(abi.encodeWithSignature(
            "afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)",
            address(this), strategyUsdgKey, uint160(1) << 96, int24(10000)));
        assertFalse(ok, "only the source PoolManager may write history");
    }

    function test_f04_incompleteSourceWindowFailsClosed() public {
        vm.prank(owner);
        pricer.setTwapParams(7 days, 2000);
        vm.expectRevert();
        pricer.quotePriceUsd(address(strategy));
    }

}

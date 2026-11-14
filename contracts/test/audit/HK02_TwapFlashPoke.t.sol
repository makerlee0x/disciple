// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Regression for audit 2026-11-14 HK-02 (docs/audit-2026-11-14.md): a flash pump + poke + dump used to plant a
// tick that persisted in the QuotePricer TWAP. Pokes are now keeper-only (others are a no-op) and clamped to 200 ticks.
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

/// @notice HK-02 fixed: the attacker's poke inside the flash is ignored, so the TWAP never sees the pumped spot.
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

    function test_HK02_flashPoke_isIgnored() public {
        _next(3600);
        pricer.poke(address(strategy));
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        _next(1);
        fp.run(15_000 * U); // the same flash that used to move the TWAP +22%
        _next(1800);
        uint256 twap = pricer.quotePriceUsd(address(strategy));
        assertApproxEqRel(twap, p0, 0.001e18, "TWAP unchanged by the flash");
        (BondingCurve c,) = _launchWithQuote(address(0), 0, 0);
        assertApproxEqRel(c.quotePriceUsd(), p0, 0.001e18, "launch bakes the fair price");
    }

    /// Even a keeper poke landing at a flashed price can record at most maxTickDelta (200 ticks ≈ 2%).
    function test_HK02_keeperPokeAtFlashedPrice_isClampedTo2pct() public {
        _next(3600);
        pricer.poke(address(strategy));
        uint256 p0 = pricer.quotePriceUsd(address(strategy));
        vm.prank(owner);
        pricer.setPoker(address(fp), true); // worst case: the keeper's poke lands inside a flash
        _next(1);
        fp.run(15_000 * U);
        _next(1800);
        uint256 twap = pricer.quotePriceUsd(address(strategy));
        assertLt(twap, p0 * 1025 / 1000, "at most ~2% from one planted observation");
    }

    function test_HK02_onlyOwnerSetsPokers() public {
        vm.expectRevert();
        vm.prank(trader1);
        pricer.setPoker(trader1, true);
        assertFalse(pricer.isPoker(trader1));
    }
}

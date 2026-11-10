// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// @title Direct test swap on the live Robinhood STRATEGY/USDG Disciple pool (internal mainnet test)
/// @notice BUY=1 (default): spend AMOUNT raw USDG for STRATEGY. BUY=0: spend AMOUNT raw STRATEGY for USDG.
///   SWAPPER=<PoolSwapTest> reuses a router from an earlier run; otherwise one is deployed.
contract SwapSameChainRH is Script {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev v0.2 hook and pool (deployed 2026-11-08); override with HOOK= / POOL_ID= / TICK_SPACING=.
    address internal constant HOOK_V02 = 0xC0E513735F35df6A82523744E2aE8a601C772a88;
    bytes32 internal constant POOL_V02 = 0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd;

    function run() external {
        require(block.chainid == 4663, "run on Robinhood Chain");
        bool buy = vm.envOr("BUY", uint256(1)) == 1;
        uint256 amt = vm.envUint("AMOUNT");
        address hook = vm.envOr("HOOK", HOOK_V02);
        bytes32 poolId = vm.envOr("POOL_ID", POOL_V02);
        int24 spacing = int24(int256(vm.envOr("TICK_SPACING", uint256(1))));
        PoolKey memory key = PoolKey(Currency.wrap(STRATEGY), Currency.wrap(USDG), 0, spacing, IHooks(hook));
        require(PoolId.unwrap(key.toId()) == poolId, "pool key");
        address inT = buy ? USDG : STRATEGY;
        address outT = buy ? STRATEGY : USDG;
        bool zeroForOne = !buy; // STRATEGY is currency0
        address me = tx.origin; // the broadcasting wallet
        uint256 b0 = IERC20(outT).balanceOf(me);

        vm.startBroadcast();
        address sw = vm.envOr("SWAPPER", address(0));
        if (sw == address(0)) sw = address(new PoolSwapTest(PM));
        IERC20(inT).approve(sw, amt);
        PoolSwapTest(sw).swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopBroadcast();

        console2.log("swapper (reuse with SWAPPER=)", sw);
        console2.log(buy ? "USDG in (raw)" : "STRATEGY in (raw)", amt);
        console2.log(buy ? "STRATEGY out (raw)" : "USDG out (raw)", IERC20(outT).balanceOf(me) - b0);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";

/// @notice RH 4663 fork quotes. Skips unless FORK_RPC_RH is set. No broadcast.
contract CompetitivenessForkTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant Q128 = 1 << 128;
    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant LIVE = 0xcEdc3C312C5B3C4310F0fba0323DDeC797E4aA88;
    bytes32 internal constant LIVE_ID = 0xddbfa6efd15715013f50e7f1cdceaab3b69b0b8e4c9d4b47fcc28e47f6a80e8f;
    bytes32 internal constant LEG1 = 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0;
    bytes32 internal constant LEG2 = 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe;

    function test_fork_idleQuotes() public {
        string memory rpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("G7_fork skipped, FORK_RPC_RH unset");
            return;
        }
        vm.createSelectFork(rpc);
        console2.log("G7_fork_block", vm.getBlockNumber());
        console2.log("G7_fork_ts", vm.getBlockTimestamp());
        console2.log("G7_fork_live_code", LIVE.code.length);
        _liveTouches();
        _newHookIdle();
    }

    function _liveKey() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(STRATEGY), Currency.wrap(USDG), 0, 1, IHooks(LIVE));
    }

    function _leg2Key() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(USDG), Currency.wrap(MSTR), 2500, 25, IHooks(address(0)));
    }

    function _swap(PoolSwapTest sw, PoolKey memory key, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256 out)
    {
        address outT = zeroForOne ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        uint256 b0 = IERC20(outT).balanceOf(address(this));
        sw.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        out = IERC20(outT).balanceOf(address(this)) - b0;
    }

    function _fund(PoolSwapTest sw) internal {
        deal(STRATEGY, address(this), 100_000_000e18);
        deal(USDG, address(this), 1_000_000e6);
        IERC20(STRATEGY).approve(address(sw), type(uint256).max);
        IERC20(USDG).approve(address(sw), type(uint256).max);
    }

    /// @dev Live hook has no sample(). First touch after extra idle, then the next block's touch.
    function _liveTouches() internal {
        PoolSwapTest sw = new PoolSwapTest(PM);
        _fund(sw);
        PoolKey memory key = _liveKey();
        require(PoolId.unwrap(key.toId()) == LIVE_ID, "live key");
        uint256 snap = vm.snapshotState();
        uint256[3] memory idle = [uint256(5 minutes), 15 minutes, 30 minutes];
        for (uint256 i = 0; i < idle.length; i++) {
            vm.revertToState(snap);
            vm.warp(vm.getBlockTimestamp() + idle[i]);
            vm.roll(vm.getBlockNumber() + 1);
            uint256 out1 = _swap(sw, key, false, 1e6); // buy STRATEGY with 1 USDG
            console2.log("G7_live_idle_sec", idle[i]);
            console2.log("  first_strategy_out", out1);
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 1);
            uint256 out2 = _swap(sw, key, false, 1e6);
            console2.log("  second_strategy_out", out2);
        }
    }

    function _newHookIdle() internal {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(PM, address(0), address(0), address(0), WETH);
        (address want, bytes32 salt) = HookMiner.find(address(this), flags, type(DiscipleHook).creationCode, args);
        DiscipleHook h = new DiscipleHook{salt: salt}(PM, address(0), address(0), address(0), WETH);
        require(address(h) == want, "mined");
        console2.log("G7_new_hook_code", address(h).code.length);

        PoolSwapTest sw = new PoolSwapTest(PM);
        _fund(sw);
        IERC20(STRATEGY).approve(address(h), type(uint256).max);
        IERC20(USDG).approve(address(h), type(uint256).max);

        DiscipleHook.Source memory s;
        s.kind = 3;
        s.coinIs0 = true;
        s.target = address(PM);
        s.v4Id = LEG1;
        s.kind2 = 3;
        s.xIs0 = false;
        s.target2 = address(PM);
        s.v4Id2 = LEG2;
        PoolKey memory k1 = PoolKey(
            Currency.wrap(STRATEGY),
            Currency.wrap(MSTR),
            0x800000,
            8,
            IHooks(0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544)
        );
        PoolKey memory k2 = _leg2Key();
        (PoolKey memory key, PoolId id) = h.createPool(
            DiscipleHook.CreateParams({
                coin: STRATEGY,
                quote: USDG,
                fee: 10_000,
                src: s,
                coinIn: 30_000_000e18,
                quoteIn: 50_000e6,
                srcKey: k1,
                srcKey2: k2
            })
        );
        DiscipleHook.PoolView memory v = h.poolState(id);
        console2.log("G7_new_strategy", v.coinReserve);
        console2.log("G7_new_usdg", v.quoteReserve);
        console2.log("G7_new_anchor", v.anchorX128);

        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 60);
        h.sample(id);
        uint256 before = _spot();
        _swap(sw, k2, true, 100_000e6);
        uint256 afterSpot = _spot();
        console2.log("G7_spot_before", before);
        console2.log("G7_spot_after_100k", afterSpot);

        uint256 snap = vm.snapshotState();
        uint256 ts = vm.getBlockTimestamp();
        uint256 bn = vm.getBlockNumber();
        uint256[3] memory idle = [uint256(5 minutes), 15 minutes, 30 minutes];
        for (uint256 i = 0; i < idle.length; i++) {
            vm.revertToState(snap);
            vm.warp(ts);
            vm.roll(bn);
            vm.roll(vm.getBlockNumber() + 1);
            h.sample(id);
            uint64 recorded = uint64(vm.getBlockTimestamp());
            vm.warp(vm.getBlockTimestamp() + idle[i]);
            vm.roll(vm.getBlockNumber() + 1);
            h.sample(id);
            uint256 out = _swap(sw, key, false, 1_000e6);
            v = h.poolState(id);
            console2.log("G7_new_with_sample_idle", idle[i]);
            console2.log("  strategy_out_per_1000usdg", out);
            console2.log("  premAt", uint256(v.premAt));
            console2.log("  recorded", uint256(recorded));
            console2.log("  lagBps", _lag(v.premAt));
            console2.log("  buyBpsVsAnchor", _over(Math.mulDiv(1_000e6, Q128, out), v.anchorX128));
        }
        for (uint256 i = 0; i < idle.length; i++) {
            vm.revertToState(snap);
            vm.warp(ts);
            vm.roll(bn);
            vm.warp(vm.getBlockTimestamp() + idle[i]);
            vm.roll(vm.getBlockNumber() + 1);
            uint256 first = _swap(sw, key, false, 1_000e6);
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 1);
            uint256 second = _swap(sw, key, false, 1_000e6);
            v = h.poolState(id);
            console2.log("G7_new_no_sample_idle", idle[i]);
            console2.log("  first_out", first);
            console2.log("  second_out", second);
            console2.log("  lagBps", _lag(v.premAt));
            console2.log("  premBuy", v.premBuy ? uint256(1) : uint256(0));
        }
    }

    function _spot() internal view returns (uint256) {
        (uint160 a,,,) = StateLibrary.getSlot0(PM, PoolId.wrap(LEG1));
        (uint160 b,,,) = StateLibrary.getSlot0(PM, PoolId.wrap(LEG2));
        uint256 s1 = Math.mulDiv(uint256(a) * uint256(a), Q128, uint256(1) << 192);
        uint256 raw = Math.mulDiv(uint256(b) * uint256(b), Q128, uint256(1) << 192);
        uint256 s2 = Math.mulDiv(Q128, Q128, raw);
        return Math.mulDiv(s1, s2, Q128);
    }

    function _lag(uint64 premAt) internal view returns (uint256) {
        uint256 elapsed = vm.getBlockTimestamp() - premAt;
        if (elapsed >= 1) return 0;
        return 400;
    }

    function _over(uint256 execX128, uint256 refX128) internal pure returns (int256) {
        if (refX128 == 0) return 0;
        if (execX128 >= refX128) return int256(Math.mulDiv(execX128 - refX128, 10_000, refX128));
        return -int256(Math.mulDiv(refX128 - execX128, 10_000, refX128));
    }
}

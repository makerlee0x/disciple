// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {BridgeV3Anchor} from "../../src/bridge/libraries/BridgeV3Anchor.sol";
import {BridgeConstants as C} from "../../src/bridge/libraries/BridgeConstants.sol";
import {MockERC20, MockV2Factory, MockV3Factory, MockV3Pool} from "./mocks/BridgeMocks.sol";

contract BridgeFixture is Test {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint24 internal constant V3_FEE = 3000;

    IPoolManager public manager;
    DiscipleHook public hook;
    PoolSwapTest public swapper;
    MockERC20 public usdg;
    MockERC20 public coin;
    MockV2Factory public v2Factory;
    MockV3Factory public v3Factory;
    PoolKey public key;
    PoolId public id;
    mapping(PoolId => MockV3Pool) internal v3Of;

    function _deployStack(uint8 usdgDec) internal {
        usdg = new MockERC20("USDG", "USDG", usdgDec);
        v2Factory = new MockV2Factory();
        v3Factory = new MockV3Factory();
        manager = IPoolManager(address(new PoolManager(address(this))));
        if (block.timestamp < 31 minutes) vm.warp(31 minutes);
        bytes memory args = abi.encode(manager, address(usdg), usdgDec, address(v2Factory), address(v3Factory));
        (address predicted, bytes32 salt) = _mineHook(args);
        hook = new DiscipleHook{salt: salt}(manager, address(usdg), usdgDec, address(v2Factory), address(v3Factory));
        require(address(hook) == predicted, "hook addr");
        swapper = new PoolSwapTest(manager);
    }

    /// @dev `HookMiner` stops at 160,444 salts. Five exact flag bits is 1 in 16,384, so some deployer
    ///      addresses (this test contract included) miss that window after a bytecode change.
    ///      Search two million salts with a tight hash. The deployed address is checked by the caller.
    function _mineHook(bytes memory args) internal view returns (address predicted, bytes32 salt) {
        bytes32 initHash = keccak256(abi.encodePacked(type(DiscipleHook).creationCode, args));
        address deployer = address(this);
        uint256 flags = HOOK_FLAGS;
        uint256 mask = uint256(Hooks.ALL_HOOK_MASK);
        uint256 found = type(uint256).max;
        assembly {
            let ptr := mload(0x40)
            // 85-byte CREATE2 preimage: 0xff ++ deployer ++ salt ++ initHash.
            mstore(ptr, or(shl(248, 0xff), shl(88, deployer)))
            mstore(add(ptr, 53), initHash)
            for { let i := 0 } lt(i, 2000000) { i := add(i, 1) } {
                mstore(add(ptr, 21), i)
                if eq(and(keccak256(ptr, 85), mask), flags) {
                    found := i
                    predicted := and(keccak256(ptr, 85), 0xffffffffffffffffffffffffffffffffffffffff)
                    break
                }
            }
        }
        require(found != type(uint256).max, "HookMiner: could not find salt");
        salt = bytes32(found);
    }

    function _newCoin(string memory name, uint8 dec) internal returns (MockERC20 c) {
        c = new MockERC20(name, name, dec);
    }

    /// @dev `tipSeed` is ignored. The hook has no keeper budget. The parameter stays so older call sites compile.
    function _create(
        MockERC20 c,
        uint256 coinSeed,
        uint256 tipSeed,
        uint16 floorBps,
        uint16 discountBps,
        uint16 outflowCapBps,
        uint32 outflowWindow
    ) internal returns (PoolKey memory k, PoolId poolId) {
        tipSeed;
        c.mint(address(this), coinSeed);
        c.approve(address(hook), type(uint256).max);
        usdg.approve(address(hook), type(uint256).max);
        MockV3Pool pool = _registerV3(c);
        (k, poolId) = hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(c),
                creator: address(this),
                floorBps: floorBps,
                discountBps: discountBps,
                outflowCapBps: outflowCapBps,
                outflowWindow: outflowWindow,
                anchorKind: C.ANCHOR_V3,
                refPool: address(pool),
                coinSeed: coinSeed,
                dutchDrift: 0,
                refPoolId: bytes32(0),
                tickSpacing: 0,
                refFee: V3_FEE,
                refTickSpacing: 0,
                refHooks: address(0)
            })
        );
        v3Of[poolId] = pool;
    }

    function _registerV3(MockERC20 c) internal returns (MockV3Pool pool) {
        address t0 = address(c) < address(usdg) ? address(c) : address(usdg);
        address t1 = address(c) < address(usdg) ? address(usdg) : address(c);
        pool = new MockV3Pool(t0, t1, 0);
        v3Factory.setPool(address(c), address(usdg), V3_FEE, address(pool));
    }

    /// @dev External so a test can advance the block without via_ir reusing a cached `block.number + 1`.
    function nextBlock() external {
        vm.roll(block.number + 1);
    }

    /// @dev Pin the v3 window to `priceWad` and put `ethTvl` of quote tokens on the reference pool, then poke.
    function _price(PoolId poolId, uint256 priceWad, uint256 ethTvl) internal {
        MockV3Pool pool = v3Of[poolId];
        require(address(pool) != address(0), "no v3");
        address quote = address(usdg);
        address coinAddr = pool.token0() == quote ? pool.token1() : pool.token0();
        bool coin0 = pool.token0() == coinAddr;
        int24 tick = _tickFor(priceWad, coin0, IERC20Metadata(coinAddr).decimals(), usdg.decimals());
        pool.pin(tick);
        deal(coinAddr, address(pool), 0);
        deal(quote, address(pool), _quoteRaw(ethTvl));
        hook.poke(poolId);
    }

    function _quoteRaw(uint256 wad) internal view returns (uint256) {
        uint8 dec = usdg.decimals();
        if (dec >= 18) return wad / 10 ** (dec - 18);
        return wad / 10 ** (18 - dec);
    }

    function _tickFor(uint256 priceWad, bool coin0, uint8 coinDec, uint8 quoteDec) internal pure returns (int24) {
        int24 lo = TickMath.MIN_TICK;
        int24 hi = TickMath.MAX_TICK;
        while (lo < hi) {
            int24 mid = int24((int256(lo) + int256(hi)) >> 1);
            uint256 p = BridgeV3Anchor.priceFromSqrt(TickMath.getSqrtPriceAtTick(mid), coin0, coinDec, quoteDec);
            if (p == priceWad) return mid;
            // Coin as token0: price rises with the tick. Coin as token1: price falls with the tick.
            bool below = coin0 ? p < priceWad : p > priceWad;
            if (below) lo = int24(int256(mid) + 1);
            else hi = mid;
        }
        if (lo == TickMath.MIN_TICK) return lo;
        int24 prev = int24(int256(lo) - 1);
        uint256 atLo = BridgeV3Anchor.priceFromSqrt(TickMath.getSqrtPriceAtTick(lo), coin0, coinDec, quoteDec);
        uint256 atPrev = BridgeV3Anchor.priceFromSqrt(TickMath.getSqrtPriceAtTick(prev), coin0, coinDec, quoteDec);
        uint256 dLo = atLo > priceWad ? atLo - priceWad : priceWad - atLo;
        uint256 dPrev = atPrev > priceWad ? atPrev - priceWad : priceWad - atPrev;
        return dPrev <= dLo ? prev : lo;
    }

    /// @dev A stale anchor is refreshed by poke. Tests that trade after the window re-post the
    ///      current anchor so the swap is about the book, not about staleness.
    function _freshen(PoolId poolId) internal {
        if (hook.curve(poolId).anchor == 0 || !hook.bridgeQuote(poolId).stale) return;
        _price(poolId, hook.curve(poolId).anchor, hook.referenceTvl(poolId));
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amountIn, bool mintLp) internal returns (BalanceDelta) {
        PoolId poolId = k.toId();
        if (hook.curve(poolId).anchor != 0 && hook.bridgeQuote(poolId).stale) {
            try hook.poke(poolId) {} catch {}
        }
        _freshen(poolId);
        Currency input = zeroForOne ? k.currency0 : k.currency1;
        MockERC20(Currency.unwrap(input)).approve(address(swapper), type(uint256).max);
        bytes memory hookData = mintLp ? abi.encode(true, address(this)) : bytes("");
        return swapper.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    function _buy(PoolKey memory k, address c, uint256 usdgIn) internal returns (BalanceDelta) {
        bool zeroForOne = Currency.unwrap(k.currency0) != c;
        return _swap(k, zeroForOne, usdgIn, false);
    }

    function _sell(PoolKey memory k, address c, uint256 coinIn) internal returns (BalanceDelta) {
        bool zeroForOne = Currency.unwrap(k.currency0) == c;
        return _swap(k, zeroForOne, coinIn, false);
    }

    function _buyLp(PoolKey memory k, address c, uint256 usdgIn) internal returns (BalanceDelta) {
        bool zeroForOne = Currency.unwrap(k.currency0) != c;
        return _swap(k, zeroForOne, usdgIn, true);
    }
}

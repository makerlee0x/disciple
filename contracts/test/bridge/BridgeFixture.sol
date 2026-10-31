// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {BridgeStorage} from "../../src/bridge/BridgeStorage.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";
import {DiscipleLpFacet} from "../../src/bridge/DiscipleLpFacet.sol";
import {DiscipleAdminFacet} from "../../src/bridge/DiscipleAdminFacet.sol";
import {DiscipleSwapFacet} from "../../src/bridge/DiscipleSwapFacet.sol";
import {MockERC20, MockLzRead} from "./mocks/BridgeMocks.sol";

contract BridgeFixture is Test {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    IPoolManager public manager;
    DiscipleHook public hook;
    PoolSwapTest public swapper;
    MockERC20 public usdg;
    MockERC20 public coin;
    MockLzRead public lz;
    DiscipleEngine public engine;
    DiscipleLpFacet public lpFacet;
    DiscipleAdminFacet public adminFacet;
    DiscipleSwapFacet public swapFacet;
    PoolKey public key;
    PoolId public id;

    function _deployStack(uint8 usdgDec) internal {
        usdg = new MockERC20("USDG", "USDG", usdgDec);
        lz = new MockLzRead();
        manager = IPoolManager(address(new PoolManager(address(this))));
        engine = new DiscipleEngine();
        adminFacet = new DiscipleAdminFacet(manager, address(usdg), address(lz), usdgDec, engine);
        lpFacet = new DiscipleLpFacet(manager, address(usdg), address(lz), usdgDec, engine);
        swapFacet = new DiscipleSwapFacet(manager, address(usdg), address(lz), usdgDec, engine);
        bytes memory args = abi.encode(
            manager,
            address(usdg),
            address(lz),
            usdgDec,
            address(engine),
            address(swapFacet),
            address(lpFacet),
            address(adminFacet),
            address(this)
        );
        (address predicted, bytes32 salt) = _mineHook(args);
        hook = new DiscipleHook{salt: salt}(
            manager,
            address(usdg),
            address(lz),
            usdgDec,
            engine,
            address(swapFacet),
            address(lpFacet),
            address(adminFacet),
            address(this)
        );
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

    function _create(
        MockERC20 c,
        uint256 coinSeed,
        uint256 tipSeed,
        uint16 floorBps,
        uint16 discountBps,
        uint16 outflowCapBps,
        uint32 outflowWindow
    ) internal returns (PoolKey memory k, PoolId poolId) {
        c.mint(address(this), coinSeed);
        c.approve(address(hook), type(uint256).max);
        if (tipSeed > 0) {
            usdg.mint(address(this), tipSeed);
            usdg.approve(address(hook), type(uint256).max);
        }
        (k, poolId) = hook.createPool(
            BridgeStorage.CreateParams({
                coin: address(c),
                creator: address(this),
                floorBps: floorBps,
                discountBps: discountBps,
                outflowCapBps: outflowCapBps,
                outflowWindow: outflowWindow,
                remoteEid: 30101,
                remoteOracle: address(0xE7E7),
                anchorKind: 0,
                v3Pool: address(0),
                coinSeed: coinSeed,
                tipSeed: tipSeed,
                dutchDrift: 0,
                refPoolId: bytes32(0),
                refHook: address(0),
                refCoinIs0: false
            })
        );
    }

    /// @dev External so a test can advance the block without via_ir reusing a cached `block.number + 1`.
    function nextBlock() external {
        vm.roll(block.number + 1);
    }

    function _price(PoolId poolId, uint256 priceWad, uint256 ethTvl) internal {
        vm.deal(address(this), 1 ether);
        hook.updatePrice{value: lz.fee()}(poolId);
        lz.fulfill(lz.lastGuid(), priceWad, ethTvl);
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amountIn, bool mintLp) internal returns (BalanceDelta) {
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

    receive() external payable {}
}

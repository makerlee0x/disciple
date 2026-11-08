// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "../../test/hook/mocks/Mocks.sol";
import {MockPair, MockV2Factory} from "../../test/hook/Disciple.t.sol";
import {_noKey} from "../../test/hook/NoKey.sol";

/// @title Keeper same-chain test helper: a whole same-chain Disciple setup on a plain local anvil
/// @notice FOR LOCAL ANVIL ONLY (keeper/test/local). Deploys a PoolManager, mock tokens, a mock v2 leader pair
///         (2 USD per COIN), a mock WETH/USD reference pair (3000 USD per ETH), the hook (1% step), and one
///         same-chain COIN/USD pool with a funded tip jar.
///           forge script script/keeper/KeeperSameChainLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract KeeperSameChainLocal is Script {
    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external {
        vm.startBroadcast();
        IPoolManager manager = IPoolManager(address(new PoolManager(msg.sender)));
        MockERC20 usd = new MockERC20("USD", "USD", 18);
        MockERC20 coin = new MockERC20("COIN", "COIN", 18);
        MockPair pair = new MockPair();
        pair.set(1_000_000e18, 2_000_000e18);
        pair.setTokens(address(coin), address(usd));
        MockV2Factory v2f = new MockV2Factory();
        v2f.add(address(pair));
        MockPair refPair = new MockPair();
        refPair.set(1_000e18, 3_000_000e18);
        DiscipleHook.Config memory cfg = DiscipleHook.Config(10_000, address(usd), 1, address(refPair), bytes32(0), true);
        bytes memory args = abi.encode(manager, address(0xdead), address(v2f), address(0), address(0), cfg);
        bytes32 salt = _mine(args);
        DiscipleHook hook = new DiscipleHook{salt: salt}(manager, address(0xdead), address(v2f), address(0), address(0), cfg);
        usd.mint(msg.sender, 1e30);
        coin.mint(msg.sender, 1e30);
        usd.approve(address(hook), type(uint256).max);
        coin.approve(address(hook), type(uint256).max);
        DiscipleHook.Source memory s;
        s.kind = 1;
        s.coinIs0 = true;
        s.target = address(pair);
        (, PoolId id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: 3000,
                src: s,
                coinIn: 1000e18,
                quoteIn: 2000e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
        hook.fundJar(id, 0, 10e18);
        vm.stopBroadcast();
        console2.log("HOOK", address(hook));
        console2.log("PAIR", address(pair));
        console2.log("POOL_ID");
        console2.logBytes32(PoolId.unwrap(id));
    }

    function _mine(bytes memory args) internal pure returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(DiscipleHook).creationCode, args));
        for (uint256 i = 0; i < 3_000_000; i++) {
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(i), initHash)))));
            if (uint160(a) & Hooks.ALL_HOOK_MASK == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "../../test/hook/mocks/Mocks.sol";
import {_noKey} from "../../test/hook/NoKey.sol";

/// @title Keeper fork test helper: create a cross-chain Disciple pool priced from an Ethereum source
/// @notice FOR LOCAL FORKS ONLY (keeper/test/fork). Deploys two mock tokens on the destination chain and creates a
///         push pool whose home source is `SRC` (kind `SRC_KIND`, default v2) on chain eid `SRC_EID`, with a tank.
///           HOOK=<hook> SRC=<pair> forge script script/keeper/KeeperForkPool.s.sol --rpc-url <anvil> --broadcast
contract KeeperForkPool is Script {
    function run() external returns (PoolId id) {
        DiscipleHook hook = DiscipleHook(payable(vm.envAddress("HOOK")));
        vm.startBroadcast();
        MockERC20 coin = new MockERC20("COIN", "COIN", 18);
        MockERC20 quote = new MockERC20("QUOTE", "QUOTE", 18);
        coin.mint(msg.sender, 1e30);
        quote.mint(msg.sender, 1e30);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        DiscipleHook.Source memory s;
        s.kind = uint8(vm.envOr("SRC_KIND", uint256(1)));
        s.coinIs0 = vm.envOr("SRC_COIN_IS_0", true);
        s.target = vm.envAddress("SRC");
        s.v4Id = vm.envOr("SRC_V4_ID", bytes32(0));
        s.remoteEid = uint32(vm.envOr("SRC_EID", uint256(30101)));
        s.push = true;
        PoolKey memory key;
        (key, id) = hook.createPool{value: vm.envOr("TANK", uint256(0.05 ether))}(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(quote),
                fee: 3000,
                src: s,
                coinIn: 1000e18,
                quoteIn: 1e29,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
        vm.stopBroadcast();
        console2.log("POOL_ID");
        console2.logBytes32(PoolId.unwrap(id));
    }
}

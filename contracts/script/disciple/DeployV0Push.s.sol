// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {DisciplePushSender} from "../../src/disciple/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/disciple/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite, LibConfig} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/disciple/routes/DiscipleRoutesV0.sol";

interface IEndpointLibs {
    function defaultSendLibrary(uint32 eid) external view returns (address);
    function defaultReceiveLibrary(uint32 eid) external view returns (address);
}

/// @title v0 deploy: Ethereum -> Robinhood LayerZero push
/// @notice Two steps, two chains. Nothing broadcasts without `--broadcast`.
///   1. On Ethereum:  forge script script/disciple/DeployV0Push.s.sol --sig "sender()" --rpc-url $ETH_RPC
///      Deploys DisciplePushSender with the v0 send config (live DVN set, 5 confirmations) for Robinhood.
///   2. On Robinhood: PUSH_SENDER=<step 1 address> QUOTE=<quote token>
///      forge script script/disciple/DeployV0Push.s.sol --sig "robinhood()" --rpc-url $RH_RPC
///      Deploys DisciplePushReceiver (peer: Ethereum -> PUSH_SENDER, ETH gas) with the matching receive config,
///      mines and deploys the Disciple hook with that receiver (no lzRead adapter on Robinhood yet, no bridge
///      sender: out of v0), and binds the receiver to the hook. The deployer keeps the receiver's add-only owner
///      role (adds new source chains later; can renounce).
contract DeployV0Push is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function sender() external returns (DisciplePushSender s) {
        require(block.chainid == 1, "run on Ethereum");
        address lib = IEndpointLibs(V0.ETH_ENDPOINT).defaultSendLibrary(V0.RH_EID);
        vm.startBroadcast();
        s = new DisciplePushSender(ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), V0.ethSendToRobinhood(lib));
        vm.stopBroadcast();
        console2.log("DisciplePushSender (Ethereum)", address(s));
        console2.log("send library", lib);
    }

    function robinhood() external returns (Disciple hook, DisciplePushReceiver r) {
        require(block.chainid == 4663, "run on Robinhood Chain");
        address pushSender = vm.envAddress("PUSH_SENDER");
        address quote = vm.envAddress("QUOTE");
        IPoolManager pm = IPoolManager(vm.envOr("POOL_MANAGER", RH_POOL_MANAGER));
        address lib = IEndpointLibs(V0.RH_ENDPOINT).defaultReceiveLibrary(V0.ETH_EID);
        uint32[] memory eids = new uint32[](1);
        address[] memory senders = new address[](1);
        bool[] memory eth = new bool[](1);
        (eids[0], senders[0], eth[0]) = (V0.ETH_EID, pushSender, true);

        vm.startBroadcast();
        r = new DisciplePushReceiver(
            ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), eids, senders, eth, V0.rhReceiveFromEthereum(lib)
        );
        bytes memory args = abi.encode(pm, quote, ILzRead(address(0)), address(0), address(r));
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        (address want, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, type(Disciple).creationCode, args);
        hook = new Disciple{salt: salt}(pm, quote, ILzRead(address(0)), address(0), address(r));
        require(address(hook) == want, "hook address");
        r.bind(IDisciplePriceTarget(address(hook)));
        vm.stopBroadcast();
        console2.log("DisciplePushReceiver (Robinhood)", address(r));
        console2.log("Disciple hook (Robinhood)", address(hook));
        console2.log("receive library", lib);
    }
}

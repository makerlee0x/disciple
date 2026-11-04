// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {DisciplePushSender} from "../../src/disciple/routes/DisciplePushSender.sol";
import {DisciplePushReceiver} from "../../src/disciple/routes/DisciplePushReceiver.sol";
import {IDisciplePriceTarget} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {ILayerZeroEndpointV2Lite, LibConfig} from "../../src/disciple/routes/ILayerZeroEndpointV2Lite.sol";
import {DiscipleRoutesV0 as V0} from "../../src/disciple/routes/DiscipleRoutesV0.sol";
import {DiscipleSelfExecutor} from "../../src/disciple/routes/DiscipleSelfExecutor.sol";

interface IEndpointLibs {
    function defaultSendLibrary(uint32 eid) external view returns (address);
    function defaultReceiveLibrary(uint32 eid) external view returns (address);
}

/// @title v0 deploy: Ethereum -> Robinhood LayerZero push
/// @notice Two steps, two chains. Nothing broadcasts without `--broadcast`.
///   Env for both steps: DVN_SET = "live" (default; the live OApp's 2 + 2-of-3) or "lean" (2 required, none
///   optional: LayerZero Labs + one more, ~0.000004 ETH of DVN fees). Use the same value on both chains.
///   1. On Ethereum:  forge script script/disciple/DeployV0Push.s.sol --sig "sender()" --rpc-url $ETH_RPC
///      Deploys DisciplePushSender with the v0 send config (5 confirmations) for Robinhood. SELF_EXECUTOR=1
///      (default) also deploys a zero-fee DiscipleSelfExecutor and points the config at it: keepers then commit and
///      execute on Robinhood themselves. SELF_EXECUTOR=0 keeps LayerZero's paid executor.
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
        bool lean = keccak256(bytes(vm.envOr("DVN_SET", string("live")))) == keccak256("lean");
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.ethLeanDvns() : V0.ethLiveDvns();
        vm.startBroadcast();
        address ex = vm.envOr("SELF_EXECUTOR", uint256(1)) == 1 ? address(new DiscipleSelfExecutor()) : address(0);
        s = new DisciplePushSender(ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), V0.ethSend(lib, ex, req, opt, th));
        vm.stopBroadcast();
        console2.log("DiscipleSelfExecutor (Ethereum, 0 = paid executor)", ex);
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
        bool lean = keccak256(bytes(vm.envOr("DVN_SET", string("live")))) == keccak256("lean");
        (address[] memory req, address[] memory opt, uint8 th) = V0.rhLiveDvns();
        if (lean) (req, opt, th) = V0.rhLeanDvns();
        LibConfig[] memory cfg = V0.rhReceive(lib, req, opt, th);
        r = new DisciplePushReceiver(ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), eids, senders, eth, cfg);
        // same-chain sources on Robinhood: v4 only unless a v2 / v3 factory is given
        address v2f = vm.envOr("V2_FACTORY", address(0));
        address v3f = vm.envOr("V3_FACTORY", address(0));
        bytes memory args = abi.encode(pm, quote, address(r), v2f, v3f);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        (address want, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, type(Disciple).creationCode, args);
        hook = new Disciple{salt: salt}(pm, quote, address(r), v2f, v3f);
        require(address(hook) == want, "hook address");
        r.bind(IDisciplePriceTarget(address(hook)));
        vm.stopBroadcast();
        console2.log("DisciplePushReceiver (Robinhood)", address(r));
        console2.log("Disciple hook (Robinhood)", address(hook));
        console2.log("receive library", lib);
    }
}

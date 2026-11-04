// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleHook} from "../../src/disciple/DiscipleHook.sol";
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

/// @title v0 deploy: LayerZero push, Ethereum -> Robinhood and Robinhood -> Ethereum
/// @notice Ethereum -> Robinhood is steps 1-2; Robinhood -> Ethereum is steps 3-4. Nothing broadcasts without
///   `--broadcast`. NOTHING DEPLOYS ON ETHEREUM UNTIL THE AUDIT (maker, 2026-11-04): steps 1 and 4 refuse to
///   broadcast unless AUDITED=1 is set; a dry run (no --broadcast) works without it.
///   Env for both steps: DVN_SET = "live" (default; the live OApp's 2 + 2-of-3) or "lean" (2 required, none
///   optional: LayerZero Labs + one more, ~0.000004 ETH of DVN fees). Use the same value on both chains.
///   1. On Ethereum:  forge script script/disciple/DeployV0Push.s.sol --sig "sender()" --rpc-url $ETH_RPC
///      Deploys DisciplePushSender with the v0 send config (5 confirmations) for Robinhood. SELF_EXECUTOR=1
///      (default) also deploys a zero-fee DiscipleSelfExecutor and points the config at it: keepers then commit and
///      execute on Robinhood themselves. SELF_EXECUTOR=0 keeps LayerZero's paid executor.
///   2. On Robinhood: PUSH_SENDER=<step 1 address>
///      forge script script/disciple/DeployV0Push.s.sol --sig "robinhood()" --rpc-url $RH_RPC
///      Deploys DisciplePushReceiver (peer: Ethereum -> PUSH_SENDER, ETH gas) with the matching receive config,
///      mines and deploys the DiscipleHook hook with that receiver (no lzRead adapter on Robinhood yet, no bridge
///      sender: out of v0), and binds the receiver to the hook. The deployer keeps the receiver's add-only owner
///      role (adds new source chains later; can renounce).
///   3. On Robinhood: forge script script/disciple/DeployV0Push.s.sol --sig "rhSender()" --rpc-url $RH_RPC
///      Deploys DisciplePushSender with the Robinhood send config (20 confirmations) for Ethereum, and with
///      SELF_EXECUTOR=1 (default) a zero-fee DiscipleSelfExecutor on Robinhood: keepers commit and execute on
///      Ethereum themselves.
///   4. On Ethereum: AUDITED=1 PUSH_SENDER=<step 3 address>
///      forge script script/disciple/DeployV0Push.s.sol --sig "ethereum()" --rpc-url $ETH_RPC
///      Deploys DisciplePushReceiver (peer: Robinhood -> PUSH_SENDER, ETH gas) with the matching receive config,
///      mines and deploys ONE combined DiscipleHook hook (any quote per pool, v2 + v3 + v4 same-chain sources incl. two-hop, and pushed
///      Robinhood prices), and binds the receiver. Overrides: POOL_MANAGER, V2_FACTORY, V3_FACTORY, WETH.
contract DeployV0Push is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant ETH_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant ETH_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ETH_V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant ETH_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    /// @dev maker's rule: no Ethereum deploy before the audit. A dry run is fine.
    modifier auditGate() {
        require(block.chainid != 1 || vm.envOr("AUDITED", uint256(0)) == 1, "Ethereum deploys wait for the audit");
        _;
    }

    function sender() external auditGate returns (DisciplePushSender s) {
        require(block.chainid == 1, "run on Ethereum");
        address lib = IEndpointLibs(V0.ETH_ENDPOINT).defaultSendLibrary(V0.RH_EID);
        bool lean = keccak256(bytes(vm.envOr("DVN_SET", string("live")))) == keccak256("lean");
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.ethLeanDvns() : V0.ethLiveDvns();
        vm.startBroadcast();
        address ex = vm.envOr("SELF_EXECUTOR", uint256(1)) == 1 ? address(new DiscipleSelfExecutor()) : address(0);
        s = new DisciplePushSender(
            ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), V0.ethSend(lib, ex, req, opt, th), V0.sendGas(lean, ex != address(0))
        );
        vm.stopBroadcast();
        console2.log("DiscipleSelfExecutor (Ethereum, 0 = paid executor)", ex);
        console2.log("DisciplePushSender (Ethereum)", address(s));
        console2.log("send library", lib);
    }

    function robinhood() external returns (DiscipleHook hook, DisciplePushReceiver r) {
        require(block.chainid == 4663, "run on Robinhood Chain");
        address pushSender = vm.envAddress("PUSH_SENDER");
        IPoolManager pm = IPoolManager(vm.envOr("POOL_MANAGER", RH_POOL_MANAGER));
        address weth = vm.envOr("WETH", RH_WETH);
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
        r = new DisciplePushReceiver(ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), eids, senders, eth, cfg, V0.destMsgGas(lean));
        // same-chain sources on Robinhood: v4 only unless a v2 / v3 factory is given
        address v2f = vm.envOr("V2_FACTORY", address(0));
        address v3f = vm.envOr("V3_FACTORY", address(0));
        bytes memory args = abi.encode(pm, address(r), v2f, v3f, weth);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        (address want, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, type(DiscipleHook).creationCode, args);
        hook = new DiscipleHook{salt: salt}(pm, address(r), v2f, v3f, weth);
        require(address(hook) == want, "hook address");
        r.bind(IDisciplePriceTarget(address(hook)));
        vm.stopBroadcast();
        console2.log("DisciplePushReceiver (Robinhood)", address(r));
        console2.log("DiscipleHook hook (Robinhood)", address(hook));
        console2.log("receive library", lib);
    }

    function rhSender() external returns (DisciplePushSender s) {
        require(block.chainid == 4663, "run on Robinhood Chain");
        address lib = IEndpointLibs(V0.RH_ENDPOINT).defaultSendLibrary(V0.ETH_EID);
        bool lean = keccak256(bytes(vm.envOr("DVN_SET", string("live")))) == keccak256("lean");
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.rhLeanDvns() : V0.rhLiveDvns();
        vm.startBroadcast();
        address ex = vm.envOr("SELF_EXECUTOR", uint256(1)) == 1 ? address(new DiscipleSelfExecutor()) : address(0);
        s = new DisciplePushSender(
            ILayerZeroEndpointV2Lite(V0.RH_ENDPOINT), V0.rhSend(lib, ex, req, opt, th), V0.sendGas(lean, ex != address(0))
        );
        vm.stopBroadcast();
        console2.log("DiscipleSelfExecutor (Robinhood, 0 = paid executor)", ex);
        console2.log("DisciplePushSender (Robinhood)", address(s));
        console2.log("send library", lib);
    }

    function ethereum() external auditGate returns (DiscipleHook hook, DisciplePushReceiver r) {
        require(block.chainid == 1, "run on Ethereum");
        address pushSender = vm.envAddress("PUSH_SENDER");
        IPoolManager pm = IPoolManager(vm.envOr("POOL_MANAGER", ETH_POOL_MANAGER));
        address weth = vm.envOr("WETH", ETH_WETH);
        address v2f = vm.envOr("V2_FACTORY", ETH_V2_FACTORY);
        address v3f = vm.envOr("V3_FACTORY", ETH_V3_FACTORY);
        address lib = IEndpointLibs(V0.ETH_ENDPOINT).defaultReceiveLibrary(V0.RH_EID);
        uint32[] memory eids = new uint32[](1);
        address[] memory senders = new address[](1);
        bool[] memory eth = new bool[](1);
        (eids[0], senders[0], eth[0]) = (V0.RH_EID, pushSender, true);
        bool lean = keccak256(bytes(vm.envOr("DVN_SET", string("live")))) == keccak256("lean");
        (address[] memory req, address[] memory opt, uint8 th) = lean ? V0.ethLeanDvns() : V0.ethLiveDvns();

        vm.startBroadcast();
        r = new DisciplePushReceiver(
            ILayerZeroEndpointV2Lite(V0.ETH_ENDPOINT), eids, senders, eth, V0.ethReceive(lib, req, opt, th), V0.destMsgGas(lean)
        );
        bytes memory args = abi.encode(pm, address(r), v2f, v3f, weth);
        (address want, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, FLAGS, type(DiscipleHook).creationCode, args);
        hook = new DiscipleHook{salt: salt}(pm, address(r), v2f, v3f, weth);
        require(address(hook) == want, "hook address");
        r.bind(IDisciplePriceTarget(address(hook)));
        vm.stopBroadcast();
        require(address(hook).code.length <= 24_576, "over EIP-170");
        console2.log("DisciplePushReceiver (Ethereum)", address(r));
        console2.log("DiscipleHook hook (Ethereum, combined)", address(hook));
        console2.log("receive library", lib);
    }
}

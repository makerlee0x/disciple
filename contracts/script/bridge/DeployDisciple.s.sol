// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";
import {DiscipleAdminFacet} from "../../src/bridge/DiscipleAdminFacet.sol";
import {DiscipleLpFacet} from "../../src/bridge/DiscipleLpFacet.sol";
import {DiscipleSwapFacet} from "../../src/bridge/DiscipleSwapFacet.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {DiscipleLzRead} from "../../src/bridge/DiscipleLzRead.sol";
import {AnchorLens} from "../../src/bridge/AnchorLens.sol";

/// @title Deploy DiscipleHook
/// @notice Deploys the engine, the three facets, a CREATE2 helper, the mined hook, and, when asked,
///         the lzRead adapter and the reference-chain lens. Does not create a pool. Does not set
///         the endpoint's read library or DVNs. Does not broadcast unless `forge script` is given
///         `--broadcast`.
///
///         Required env:
///           POOL_MANAGER     Uniswap v4 PoolManager on this chain. Not guessed.
///           USDG             Quote token.
///           USDG_DECIMALS    Must match `USDG.decimals()` when the token exposes it.
///           BUILDER          Recipient of the 1% graduated-fee share. One global address.
///                            Only that address can hand the role off. Pool creators cannot.
///         LayerZero, one of:
///           LZ               An already deployed `DiscipleLzRead`. The script does not call `setHook`
///                            on it. The owner does that once the hook address is mined.
///           LZ_ENDPOINT      Endpoint V2 on this chain. The script deploys `DiscipleLzRead` against it.
///           READ_CHANNEL     Read channel the adapter sends to and accepts from. LayerZero read
///                            channel 1 is 4294967295. Required when `LZ` is unset.
///         Optional env:
///           LZ_CONFIRMATIONS Confirmation floor stored on the adapter. Default 15. A request can
///                            raise it. It cannot lower it. Ignored when `LZ` is already set.
///           DEPLOY_LENS      Unset deploys `AnchorLens` and logs it. `0` skips it. The lens is the
///                            lzRead target, and it belongs on the chain that holds the reference pool.
///                            That may be a different chain from the hook. Run this script there too,
///                            or deploy `AnchorLens` on its own.
///
///         `DEPLOY_MOCKS` is rejected. A permissionless price push is test-only.
///
///         After this script, the endpoint delegate (the adapter's owner) still has to point the read
///         channel at that chain's ReadLib (`setSendLibrary`, `setReceiveLibrary`) and call
///         `endpoint.setConfig` with the DVNs that support the reference endpoint id and timestamp
///         reads. The adapter does not pick a DVN.
///
///         The hook is mined with `HookMiner` and deployed by a helper this script deploys, so the
///         Arachnid CREATE2 proxy does not have to be on the chain. Deploy order when this script
///         creates the adapter: adapter (hook unset), facets, mined hook, then `setHook` once.
contract DeployDisciple is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address usdg = vm.envAddress("USDG");
        uint8 usdgDecimals = uint8(vm.envUint("USDG_DECIMALS"));
        address builder_ = vm.envAddress("BUILDER");
        if (vm.envOr("DEPLOY_MOCKS", uint256(0)) == 1) revert("DEPLOY_MOCKS is test-only");
        bool deployLens = vm.envOr("DEPLOY_LENS", uint256(1)) != 0;

        if (poolManager.code.length == 0) revert("POOL_MANAGER has no code");
        if (usdg.code.length == 0) revert("USDG has no code");
        if (builder_ == address(0)) revert("BUILDER unset");
        _checkDecimals(usdg, usdgDecimals);

        (address lz, bool lzSet) = _optional("LZ");
        address endpoint;
        uint32 readChannel;
        uint16 confirmations;
        if (!lzSet) {
            endpoint = vm.envAddress("LZ_ENDPOINT");
            if (endpoint == address(0)) revert("set LZ, or LZ_ENDPOINT and READ_CHANNEL");
            uint256 channelRaw = vm.envUint("READ_CHANNEL");
            if (channelRaw == 0 || channelRaw > type(uint32).max) revert("READ_CHANNEL");
            readChannel = uint32(channelRaw);
            uint256 confRaw = vm.envOr("LZ_CONFIRMATIONS", uint256(15));
            if (confRaw == 0 || confRaw > type(uint16).max) revert("LZ_CONFIRMATIONS");
            confirmations = uint16(confRaw);
        }

        vm.startBroadcast();
        DiscipleLzRead deployed;
        if (!lzSet) {
            deployed = new DiscipleLzRead(endpoint, readChannel, confirmations, msg.sender);
            lz = address(deployed);
        }
        DiscipleEngine engine = new DiscipleEngine();
        DiscipleAdminFacet adminFacet =
            new DiscipleAdminFacet(IPoolManager(poolManager), usdg, lz, usdgDecimals, engine);
        DiscipleLpFacet lpFacet = new DiscipleLpFacet(IPoolManager(poolManager), usdg, lz, usdgDecimals, engine);
        DiscipleSwapFacet swapFacet = new DiscipleSwapFacet(IPoolManager(poolManager), usdg, lz, usdgDecimals, engine);
        ScriptCreate2 deployer = new ScriptCreate2();
        AnchorLens lens;
        if (deployLens) lens = new AnchorLens();
        vm.stopBroadcast();

        bytes memory args = abi.encode(
            IPoolManager(poolManager),
            usdg,
            lz,
            usdgDecimals,
            engine,
            address(swapFacet),
            address(lpFacet),
            address(adminFacet),
            builder_
        );
        (address predicted, bytes32 salt) =
            HookMiner.find(address(deployer), HOOK_FLAGS, type(DiscipleHook).creationCode, args);

        vm.startBroadcast();
        address hook = deployer.deploy(abi.encodePacked(type(DiscipleHook).creationCode, args), salt);
        if (address(deployed) != address(0)) deployed.setHook(hook);
        vm.stopBroadcast();
        if (hook != predicted) revert("hook address mismatch");
        if (hook.code.length == 0) revert("hook has no code");

        console2.log("chain id", block.chainid);
        console2.log("pool manager", poolManager);
        console2.log("usdg", usdg);
        console2.log("usdg decimals", usdgDecimals);
        console2.log("builder", builder_);
        console2.log("lz", lz);
        if (address(deployed) != address(0)) {
            console2.log("lz endpoint", endpoint);
            console2.log("read channel", readChannel);
            console2.log("confirmations", confirmations);
            console2.log("setHook called");
        } else {
            console2.log("pre-set adapter; setHook was not called");
        }
        console2.log("engine", address(engine));
        console2.log("admin facet", address(adminFacet));
        console2.log("lp facet", address(lpFacet));
        console2.log("swap facet", address(swapFacet));
        console2.log("create2", address(deployer));
        console2.log("hook", hook);
        if (address(lens) != address(0)) console2.log("anchor lens", address(lens));
    }

    function _optional(string memory key) internal view returns (address value, bool set) {
        try vm.envAddress(key) returns (address v) {
            return (v, v != address(0));
        } catch {
            return (address(0), false);
        }
    }

    function _checkDecimals(address usdg, uint8 expected) internal view {
        (bool ok, bytes memory data) = usdg.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length < 32) return;
        uint8 onchain = abi.decode(data, (uint8));
        if (onchain != expected) revert("USDG_DECIMALS does not match the token");
    }
}

/// @dev Deploys the mined hook. The CREATE2 deployer is this contract, not the Arachnid proxy.
contract ScriptCreate2 {
    function deploy(bytes memory initCode, bytes32 salt) external returns (address addr) {
        assembly {
            addr := create2(0, add(initCode, 0x20), mload(initCode), salt)
            if iszero(addr) { revert(0, 0) }
        }
    }
}

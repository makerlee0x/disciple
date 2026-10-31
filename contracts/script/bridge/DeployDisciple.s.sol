// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";
import {DiscipleAdminFacet} from "../../src/bridge/DiscipleAdminFacet.sol";
import {DiscipleLpFacet} from "../../src/bridge/DiscipleLpFacet.sol";
import {DiscipleCreateFacet} from "../../src/bridge/DiscipleCreateFacet.sol";
import {DiscipleSwapFacet} from "../../src/bridge/DiscipleSwapFacet.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {DiscipleLzRead} from "../../src/bridge/DiscipleLzRead.sol";
import {ILzRead, ILzReadConsumer} from "../../src/bridge/interfaces/ILzRead.sol";
import {AnchorLens} from "../../src/bridge/AnchorLens.sol";

/// @title Deploy DiscipleHook
/// @notice Deploys the engine, the four facets, a CREATE2 helper, the mined hook, and, when asked,
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
///         `DEPLOY_MOCKS=1` is accepted only on chain id 31337 or 1337. It deploys an owner-gated
///         stand-in for the adapter. Any other chain id reverts. The owner is the only caller of
///         `fulfill`. The hook still rejects a cross-chain kind when `lz` is the zero address.
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
    address internal created;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    struct Env {
        address poolManager;
        address usdg;
        uint8 usdgDecimals;
        address builder_;
        address factory;
        address lz;
        bool lzSet;
        address endpoint;
        uint32 readChannel;
        uint16 confirmations;
        bool mocks;
        bool deployLens;
    }

    function run() external {
        Env memory e = _env();
        (
            address hook,
            address lz,
            address engine,
            address adminFacet,
            address lpFacet,
            address swapFacet,
            address deployer,
            address lens,
            bool deployedAdapter,
            bool deployedMock
        ) = _deploy(e);
        _log(e, hook, lz, engine, adminFacet, lpFacet, swapFacet, deployer, lens, deployedAdapter, deployedMock);
    }

    function _env() internal view returns (Env memory e) {
        e.poolManager = vm.envAddress("POOL_MANAGER");
        e.usdg = vm.envAddress("USDG");
        e.usdgDecimals = uint8(vm.envUint("USDG_DECIMALS"));
        e.builder_ = vm.envAddress("BUILDER");
        e.factory = vm.envOr("V3_FACTORY", address(0));
        e.mocks = vm.envOr("DEPLOY_MOCKS", uint256(0)) == 1;
        e.deployLens = vm.envOr("DEPLOY_LENS", uint256(1)) != 0;
        if (e.mocks && block.chainid != 31337 && block.chainid != 1337) revert("DEPLOY_MOCKS is local-only");
        if (e.poolManager.code.length == 0) revert("POOL_MANAGER has no code");
        if (e.usdg.code.length == 0) revert("USDG has no code");
        if (e.builder_ == address(0)) revert("BUILDER unset");
        _checkDecimals(e.usdg, e.usdgDecimals);
        (e.lz, e.lzSet) = _optional("LZ");
        if (e.mocks) return e;
        if (e.lzSet) return e;
        e.endpoint = vm.envAddress("LZ_ENDPOINT");
        if (e.endpoint == address(0)) revert("set LZ, or LZ_ENDPOINT and READ_CHANNEL");
        uint256 channelRaw = vm.envUint("READ_CHANNEL");
        if (channelRaw == 0 || channelRaw > type(uint32).max) revert("READ_CHANNEL");
        e.readChannel = uint32(channelRaw);
        uint256 confRaw = vm.envOr("LZ_CONFIRMATIONS", uint256(15));
        if (confRaw == 0 || confRaw > type(uint16).max) revert("LZ_CONFIRMATIONS");
        e.confirmations = uint16(confRaw);
    }

    function _deploy(Env memory e)
        internal
        returns (
            address hook,
            address lz,
            address engine,
            address adminFacet,
            address lpFacet,
            address swapFacet,
            address deployer,
            address lens,
            bool deployedAdapter,
            bool deployedMock
        )
    {
        vm.startBroadcast();
        lz = e.lz;
        DiscipleLzRead adapter;
        ScriptLzRead mock;
        if (e.mocks) {
            mock = new ScriptLzRead(msg.sender);
            lz = address(mock);
            deployedMock = true;
        } else if (!e.lzSet) {
            adapter = new DiscipleLzRead(e.endpoint, e.readChannel, e.confirmations, msg.sender);
            lz = address(adapter);
            deployedAdapter = true;
        }
        DiscipleEngine engineC = new DiscipleEngine();
        DiscipleAdminFacet adminC =
            new DiscipleAdminFacet(IPoolManager(e.poolManager), e.usdg, lz, e.usdgDecimals, engineC, e.factory);
        DiscipleLpFacet lpC =
            new DiscipleLpFacet(IPoolManager(e.poolManager), e.usdg, lz, e.usdgDecimals, engineC, e.factory);
        DiscipleCreateFacet createC =
            new DiscipleCreateFacet(IPoolManager(e.poolManager), e.usdg, lz, e.usdgDecimals, engineC, e.factory);
        DiscipleSwapFacet swapC =
            new DiscipleSwapFacet(IPoolManager(e.poolManager), e.usdg, lz, e.usdgDecimals, engineC, e.factory);
        created = address(createC);
        ScriptCreate2 create2 = new ScriptCreate2();
        AnchorLens lensC;
        if (e.deployLens) lensC = new AnchorLens();
        vm.stopBroadcast();

        bytes memory args = abi.encode(
            IPoolManager(e.poolManager),
            e.usdg,
            lz,
            e.usdgDecimals,
            engineC,
            address(swapC),
            address(lpC),
            address(createC),
            address(adminC),
            e.builder_,
            e.factory
        );
        (address predicted, bytes32 salt) =
            HookMiner.find(address(create2), HOOK_FLAGS, type(DiscipleHook).creationCode, args);

        vm.startBroadcast();
        hook = create2.deploy(abi.encodePacked(type(DiscipleHook).creationCode, args), salt);
        if (address(adapter) != address(0)) adapter.setHook(hook);
        if (address(mock) != address(0)) mock.setConsumer(hook);
        vm.stopBroadcast();
        if (hook != predicted) revert("hook address mismatch");
        if (hook.code.length == 0) revert("hook has no code");
        engine = address(engineC);
        adminFacet = address(adminC);
        lpFacet = address(lpC);
        swapFacet = address(swapC);
        deployer = address(create2);
        lens = address(lensC);
    }

    function _log(
        Env memory e,
        address hook,
        address lz,
        address engine,
        address adminFacet,
        address lpFacet,
        address swapFacet,
        address deployer,
        address lens,
        bool deployedAdapter,
        bool deployedMock
    ) internal view {
        console2.log("chain id", block.chainid);
        console2.log("pool manager", e.poolManager);
        console2.log("usdg", e.usdg);
        console2.log("usdg decimals", e.usdgDecimals);
        console2.log("builder", e.builder_);
        console2.log("v3 factory", e.factory);
        console2.log("lz", lz);
        if (deployedMock) console2.log("local owner-gated lz mock");
        if (deployedAdapter) {
            console2.log("lz endpoint", e.endpoint);
            console2.log("read channel", e.readChannel);
            console2.log("confirmations", e.confirmations);
            console2.log("setHook called");
        } else if (!deployedMock) {
            console2.log("pre-set adapter; setHook was not called");
        }
        console2.log("engine", engine);
        console2.log("admin facet", adminFacet);
        console2.log("lp facet", lpFacet);
        console2.log("create facet", created);
        console2.log("swap facet", swapFacet);
        console2.log("create2", deployer);
        console2.log("hook", hook);
        if (lens != address(0)) console2.log("anchor lens", lens);
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

/// @dev Local-chain stand-in. `fulfill` is owner-only. Not a permissionless price push.
contract ScriptLzRead is ILzRead {
    address public owner;
    address public consumer;
    uint256 public fee = 0.001 ether;
    uint256 internal n;
    bytes32 public lastGuid;

    error NotOwner();
    error NotHook();

    constructor(address owner_) {
        owner = owner_;
    }

    function setConsumer(address next) external {
        if (msg.sender != owner) revert NotOwner();
        consumer = next;
    }

    function quoteRead(EvmRead calldata) external view returns (uint256 nativeFee) {
        return fee;
    }

    function sendRead(EvmRead calldata, address) external payable returns (bytes32 guid) {
        if (msg.sender != consumer) revert NotHook();
        n += 1;
        guid = keccak256(abi.encode(address(this), n));
        lastGuid = guid;
    }

    function fulfill(bytes32 guid, uint256 priceWad, uint256 tvlWad) external {
        if (msg.sender != owner) revert NotOwner();
        ILzReadConsumer(consumer).onLzRead(guid, abi.encode(priceWad, tvlWad));
    }

    function fulfillBytes(bytes32 guid, bytes calldata result) external {
        if (msg.sender != owner) revert NotOwner();
        ILzReadConsumer(consumer).onLzRead(guid, result);
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

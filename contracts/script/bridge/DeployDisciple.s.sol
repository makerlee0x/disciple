// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ILzRead, ILzReadConsumer} from "../../src/bridge/interfaces/ILzRead.sol";
import {DiscipleEngine} from "../../src/bridge/DiscipleEngine.sol";
import {DiscipleAdminFacet} from "../../src/bridge/DiscipleAdminFacet.sol";
import {DiscipleLpFacet} from "../../src/bridge/DiscipleLpFacet.sol";
import {DiscipleSwapFacet} from "../../src/bridge/DiscipleSwapFacet.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";
import {V4SlotReader} from "../../src/bridge/V4SlotReader.sol";

/// @title Deploy DiscipleHook
/// @notice Deploys the engine, the three facets, a CREATE2 helper, and the mined hook.
///         Does not create a pool and does not broadcast unless `forge script` is given `--broadcast`.
///
///         Required env:
///           POOL_MANAGER     Uniswap v4 PoolManager on this chain. Not guessed.
///           USDG             Quote token.
///           USDG_DECIMALS    Must match `USDG.decimals()` when the token exposes it.
///         Optional env:
///           VAULT            ERC-4626 whose asset is USDG. Robinhood mainnet Steakhouse
///                            (0xBeEff033F34C046626B8D0A041844C5d1A5409dd) is chain-specific.
///                            Testnet often does not have it.
///           LZ               Adapter that implements `ILzRead`. Required for cross-chain anchors.
///           DEPLOY_MOCKS     `1` deploys a mock ERC-4626 and a mock lz reader for any of
///                            VAULT / LZ that was left unset. The mock reader records the read
///                            and does not deliver it. Call `fulfill` / `fulfillBytes` yourself.
///           DEPLOY_SLOT_READER  `0` skips `V4SlotReader`. Any other value (including unset)
///                            deploys it against POOL_MANAGER. That contract is the lzRead target
///                            for `ANCHOR_LZ_V4_SLOT`, and it belongs on the chain that holds the
///                            reference v4 pool.
///
///         The hook is mined with `HookMiner` and deployed by a helper this script deploys, so the
///         Arachnid CREATE2 proxy does not have to be on the chain.
contract DeployDisciple is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address usdg = vm.envAddress("USDG");
        uint8 usdgDecimals = uint8(vm.envUint("USDG_DECIMALS"));
        bool mocks = vm.envOr("DEPLOY_MOCKS", uint256(0)) == 1;
        bool deployReader = vm.envOr("DEPLOY_SLOT_READER", uint256(1)) != 0;

        if (poolManager.code.length == 0) revert("POOL_MANAGER has no code");
        if (usdg.code.length == 0) revert("USDG has no code");
        _checkDecimals(usdg, usdgDecimals);

        (address vault, bool vaultSet) = _optional("VAULT");
        (address lz, bool lzSet) = _optional("LZ");
        if (!vaultSet && !mocks) revert("VAULT unset; set it or DEPLOY_MOCKS=1");
        if (!lzSet && !mocks) revert("LZ unset; set it or DEPLOY_MOCKS=1");

        vm.startBroadcast();
        if (!vaultSet) {
            vault = address(new ScriptVault(IERC20(usdg)));
            console2.log("mock vault", vault);
        }
        if (!lzSet) {
            lz = address(new ScriptLzRead());
            console2.log("mock lz reader", lz);
        }
        if (IERC4626(vault).asset() != usdg) revert("vault asset is not USDG");

        DiscipleEngine engine = new DiscipleEngine();
        DiscipleAdminFacet adminFacet =
            new DiscipleAdminFacet(IPoolManager(poolManager), usdg, vault, lz, usdgDecimals, engine);
        DiscipleLpFacet lpFacet =
            new DiscipleLpFacet(IPoolManager(poolManager), usdg, vault, lz, usdgDecimals, engine, address(adminFacet));
        DiscipleSwapFacet swapFacet = new DiscipleSwapFacet(
            IPoolManager(poolManager), usdg, vault, lz, usdgDecimals, engine, address(adminFacet)
        );
        ScriptCreate2 deployer = new ScriptCreate2();
        V4SlotReader reader;
        if (deployReader) reader = new V4SlotReader(IPoolManager(poolManager));
        vm.stopBroadcast();

        bytes memory args = abi.encode(
            IPoolManager(poolManager),
            usdg,
            vault,
            lz,
            usdgDecimals,
            engine,
            address(swapFacet),
            address(lpFacet),
            address(adminFacet)
        );
        (address predicted, bytes32 salt) =
            HookMiner.find(address(deployer), HOOK_FLAGS, type(DiscipleHook).creationCode, args);

        vm.startBroadcast();
        address hook = deployer.deploy(abi.encodePacked(type(DiscipleHook).creationCode, args), salt);
        vm.stopBroadcast();
        if (hook != predicted) revert("hook address mismatch");
        if (hook.code.length == 0) revert("hook has no code");

        console2.log("chain id", block.chainid);
        console2.log("pool manager", poolManager);
        console2.log("usdg", usdg);
        console2.log("usdg decimals", usdgDecimals);
        console2.log("vault", vault);
        console2.log("lz", lz);
        console2.log("engine", address(engine));
        console2.log("admin facet", address(adminFacet));
        console2.log("lp facet", address(lpFacet));
        console2.log("swap facet", address(swapFacet));
        console2.log("create2", address(deployer));
        console2.log("hook", hook);
        if (address(reader) != address(0)) console2.log("v4 slot reader", address(reader));
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

/// @dev Stand-in ERC-4626 so the hook can be constructed where Steakhouse USDG is not deployed.
contract ScriptVault is ERC4626 {
    constructor(IERC20 usdg_) ERC20("Mock Steakhouse USDG", "mstUSDG") ERC4626(usdg_) {}
}

/// @dev Records an lzRead and does not call back. `fulfill` / `fulfillBytes` complete it.
contract ScriptLzRead is ILzRead {
    uint256 public n;
    bytes32 public lastGuid;
    bytes public lastCallData;
    address public lastTarget;
    uint32 public lastEid;
    address public consumer;

    function quoteRead(EvmRead calldata) external pure returns (uint256 nativeFee) {
        return 0;
    }

    function sendRead(EvmRead calldata read, address) external payable returns (bytes32 guid) {
        n += 1;
        guid = bytes32(n);
        lastGuid = guid;
        lastCallData = read.callData;
        lastTarget = read.target;
        lastEid = read.targetEid;
        consumer = msg.sender;
    }

    function fulfill(bytes32 guid, uint256 priceWad, uint256 tvlWad) external {
        if (guid != lastGuid) revert("guid");
        ILzReadConsumer(consumer).onLzRead(guid, abi.encode(priceWad, tvlWad));
    }

    function fulfillBytes(bytes32 guid, bytes calldata result) external {
        if (guid != lastGuid) revert("guid");
        ILzReadConsumer(consumer).onLzRead(guid, result);
    }
}

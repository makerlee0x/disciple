// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleHook} from "../../src/bridge/DiscipleHook.sol";

/// @title Deploy DiscipleHook
/// @notice Forge deploys and links the four libraries before the hook, because the hook's creation
///         code contains their addresses. Nothing in that set can be replaced later. The script then
///         mines a CREATE2 salt for the linked creation code and deploys the hook. It does not create
///         a pool. It does not broadcast unless `forge script` is given `--broadcast`.
///
///         Link order, which is also the deploy order:
///           1. DiscipleMath     curve, Dutch, fee split, graduation step
///           2. DiscipleAnchor   v2 / v3 / v4 reads
///           3. DiscipleBook     create, swap, poke, seed
///           4. DiscipleLp       deposit, redeem, claim, quotes
///           5. DiscipleHook     mined. Holds every token and every storage slot.
///
///         Required env:
///           POOL_MANAGER   Uniswap v4 PoolManager on this chain.
///           USDG           Quote token.
///           USDG_DECIMALS  Must match `USDG.decimals()` when the token exposes it.
///         Optional env:
///           V2_FACTORY     Uniswap v2 factory. Unset stores address zero. v2 creates then revert.
///           V3_FACTORY     Uniswap v3 factory. Unset stores address zero. v3 creates then revert.
///
///         Mine against the linked creation code. `type(DiscipleHook).creationCode` in a forge script
///         is already linked to the libraries this compilation will deploy.
contract DeployDisciple is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    struct Env {
        address poolManager;
        address usdg;
        uint8 usdgDecimals;
        address v2Factory;
        address v3Factory;
    }

    function run() external {
        Env memory e = _env();
        (address hook, address deployer) = _deploy(e);
        DiscipleHook deployed = DiscipleHook(hook);
        console2.log("chain id", block.chainid);
        console2.log("pool manager", e.poolManager);
        console2.log("usdg", e.usdg);
        console2.log("usdg decimals", e.usdgDecimals);
        console2.log("v2 factory", e.v2Factory);
        console2.log("v3 factory", e.v3Factory);
        console2.log("math", deployed.mathLibrary());
        console2.log("anchor", deployed.anchorLibrary());
        console2.log("book", deployed.bookLibrary());
        console2.log("lp", deployed.lpLibrary());
        console2.log("create2", deployer);
        console2.log("hook", hook);
    }

    function _env() internal view returns (Env memory e) {
        e.poolManager = vm.envAddress("POOL_MANAGER");
        e.usdg = vm.envAddress("USDG");
        e.usdgDecimals = uint8(vm.envUint("USDG_DECIMALS"));
        e.v2Factory = vm.envOr("V2_FACTORY", address(0));
        e.v3Factory = vm.envOr("V3_FACTORY", address(0));
        if (e.poolManager.code.length == 0) revert("POOL_MANAGER has no code");
        if (e.usdg.code.length == 0) revert("USDG has no code");
        if (e.usdgDecimals > 18) revert("USDG_DECIMALS");
        _checkDecimals(e.usdg, e.usdgDecimals);
    }

    function _deploy(Env memory e) internal returns (address hook, address deployer) {
        vm.startBroadcast();
        // Forge deploys and links DiscipleMath, DiscipleAnchor, DiscipleBook, and DiscipleLp
        // before this CREATE2 helper, because the hook creation code below names them.
        ScriptCreate2 create2 = new ScriptCreate2();
        vm.stopBroadcast();

        bytes memory args = abi.encode(IPoolManager(e.poolManager), e.usdg, e.usdgDecimals, e.v2Factory, e.v3Factory);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(create2), HOOK_FLAGS, type(DiscipleHook).creationCode, args);

        vm.startBroadcast();
        hook = create2.deploy(abi.encodePacked(type(DiscipleHook).creationCode, args), salt);
        vm.stopBroadcast();
        if (hook != predicted) revert("hook address mismatch");
        if (hook.code.length == 0) revert("hook has no code");
        if (hook.code.length > 24_576) revert("hook over EIP-170");
        deployer = address(create2);
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

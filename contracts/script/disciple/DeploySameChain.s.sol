// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";

interface IMeta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @title Same-chain Disciple deploy (v0)
/// @notice Deploys one Disciple hook that serves same-chain pools only (no push receiver). Every cross-chain `createPool` reverts with BadParams on this deployment, and `msg.value` must be
///         0, so no ETH tank or TJAR is involved. One deployment per quote token.
///
///         maker (2026-11-04): one combined hook per chain. On Robinhood that is DeployV0Push.robinhood() (same-chain
///         plus the Ethereum price push). On Ethereum v0 has no inbound price route, so this script IS the combined
///         hook there; a later inbound route means a new hook.
///
///         Dry run (no broadcast):
///           forge script script/disciple/DeploySameChain.s.sol --rpc-url $RPC
///         Live (only with maker's go):
///           forge script script/disciple/DeploySameChain.s.sol --rpc-url $RPC --broadcast --private-key ...
///
///         Env (all optional on Ethereum and Robinhood Chain, which have defaults):
///           QUOTE          quote token; default USDG on both chains (maker, 2026-11-04)
///           POOL_MANAGER   v4 PoolManager; default the canonical one on the chain
///           V2_FACTORY     Uniswap v2 factory that same-chain v2 sources must come from; 0 turns v2 sources off.
///                          Default: Ethereum's; off on Robinhood (no Uniswap v2 there that we know of)
///           V3_FACTORY     same for v3. Default: Ethereum's; off on Robinhood
///
///         The hook address is mined for its five flags. CREATE2 goes through the Arachnid proxy when the chain has it,
///         otherwise through a one-off helper this script deploys first.
contract DeploySameChain is Script {
    address internal constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant EIP170 = 24_576;

    uint256 internal constant ETHEREUM = 1;
    uint256 internal constant ROBINHOOD = 4663;
    address internal constant ETH_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev Robinhood USDG, as the Disciple app uses it (web/lib/chains.ts); the script confirms symbol and decimals.
    address internal constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev Ethereum USDG (Paxos Global Dollar; maker's screenshot shows 0xe34...95491d)
    address internal constant ETH_USDG = 0xe343167631d89B6Ffc58B88d6b7fB0228795491D;
    address internal constant ETH_V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant ETH_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

    struct Config {
        address pm;
        address quote;
        address v2Factory;
        address v3Factory;
    }

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external returns (Disciple hook) {
        Config memory c = config();
        require(c.pm.code.length != 0, "POOL_MANAGER has no code");
        require(c.quote.code.length != 0, "QUOTE has no code");
        if (c.quote == RH_USDG || c.quote == ETH_USDG) {
            require(keccak256(bytes(IMeta(c.quote).symbol())) == keccak256("USDG"), "QUOTE is not USDG");
            require(IMeta(c.quote).decimals() == 6, "USDG decimals");
        }
        require(c.v2Factory == address(0) || c.v2Factory.code.length != 0, "V2_FACTORY has no code");
        require(c.v3Factory == address(0) || c.v3Factory.code.length != 0, "V3_FACTORY has no code");

        bytes memory args = abi.encode(IPoolManager(c.pm), c.quote, address(0), c.v2Factory, c.v3Factory);
        bytes memory init = abi.encodePacked(type(Disciple).creationCode, args);

        vm.startBroadcast();
        address factory = ARACHNID.code.length != 0 ? ARACHNID : address(new SameChainCreate2());
        vm.stopBroadcast();

        (address want, bytes32 salt) = HookMiner.find(factory, FLAGS, type(Disciple).creationCode, args);
        require(want.code.length == 0, "hook already deployed at the mined address");

        vm.startBroadcast();
        address got = factory == ARACHNID ? _viaArachnid(salt, init) : SameChainCreate2(factory).deploy(init, salt);
        vm.stopBroadcast();

        require(got == want, "hook address mismatch");
        hook = Disciple(payable(got));
        check(hook, c);

        console2.log("chain id", block.chainid);
        console2.log("pool manager", c.pm);
        console2.log("quote", c.quote);
        console2.log("v2 factory (0 = v2 sources off)", c.v2Factory);
        console2.log("v3 factory (0 = v3 sources off)", c.v3Factory);
        console2.log("create2 factory", factory);
        console2.log("salt");
        console2.logBytes32(salt);
        console2.log("Disciple hook (same chain only)", got);
        console2.log("runtime size", got.code.length);
    }

    /// @notice Chain defaults, overridable by env.
    function config() public view returns (Config memory c) {
        Config memory d = defaults(block.chainid);
        c.pm = vm.envOr("POOL_MANAGER", d.pm);
        c.quote = vm.envOr("QUOTE", d.quote);
        c.v2Factory = vm.envOr("V2_FACTORY", d.v2Factory);
        c.v3Factory = vm.envOr("V3_FACTORY", d.v3Factory);
        require(c.pm != address(0), "set POOL_MANAGER for this chain");
        require(c.quote != address(0), "set QUOTE for this chain");
    }

    /// @notice Built-in defaults per chain (all zero elsewhere).
    function defaults(uint256 chainId) public pure returns (Config memory d) {
        if (chainId == ETHEREUM) d = Config(ETH_POOL_MANAGER, ETH_USDG, ETH_V2_FACTORY, ETH_V3_FACTORY);
        else if (chainId == ROBINHOOD) d = Config(RH_POOL_MANAGER, RH_USDG, address(0), address(0));
    }

    /// @notice Post-deploy checks: wiring, flags, size, and that every cross-chain route is off.
    function check(Disciple hook, Config memory c) public view {
        require(address(hook.poolManager()) == c.pm, "pool manager");
        require(hook.quote() == c.quote, "quote");
        require(hook.v2Factory() == c.v2Factory && hook.v3Factory() == c.v3Factory, "factories");
        require(hook.pushReceiver() == address(0), "push receiver must be off");
        require(uint160(address(hook)) & Hooks.ALL_HOOK_MASK == FLAGS, "hook flags");
        require(address(hook).code.length <= EIP170, "over EIP-170");
    }

    function _viaArachnid(bytes32 salt, bytes memory init) internal returns (address got) {
        (bool ok, bytes memory ret) = ARACHNID.call(abi.encodePacked(salt, init));
        require(ok && ret.length == 20, "create2 proxy failed");
        got = address(bytes20(ret));
    }
}

/// @dev CREATE2 helper for chains without the Arachnid proxy.
contract SameChainCreate2 {
    function deploy(bytes memory initCode, bytes32 salt) external returns (address addr) {
        assembly {
            addr := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(addr != address(0), "create2 failed");
    }
}

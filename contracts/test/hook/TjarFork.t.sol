// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {_noKey} from "./NoKey.sol";
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @dev TJAR factory on Robinhood Chain. Its source is not verified to us; the call below was read from its bytecode
///      and a traced call: selector 0x63d23abd(resource, resourceRecipient, threshold, owner, address, salt)
///      returns (jar, releaser). The function name is unknown, so it is called by selector.
library Tjar {
    bytes4 internal constant DEPLOY = 0x63d23abd;

    function deploy(
        address factory,
        address resource,
        address recipient,
        uint256 threshold,
        address owner,
        uint256 salt
    ) internal returns (address jar, address releaser) {
        (bool ok, bytes memory r) = factory.call(
            abi.encodeWithSelector(DEPLOY, resource, recipient, threshold, owner, address(0), salt)
        );
        require(ok, "TJAR deploy reverted");
        (jar, releaser) = abi.decode(r, (address, address));
    }
}

/// @dev Releaser: whoever pays `threshold` of `resource` to `resourceRecipient` takes the jar's listed assets.
///      The 4th argument is not named on chain; a value >= threshold works (reads like a max-payment guard).
interface ITjarReleaser {
    function release(uint256 nonce, address[] calldata assets, address recipient, uint256 maxPay) external;
    function nonce() external view returns (uint256);
    function threshold() external view returns (uint256);
    function resource() external view returns (address);
    function resourceRecipient() external view returns (address);
    function TOKEN_JAR() external view returns (address);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IEndpointV2Lite {
    function eid() external view returns (uint32);
    function getRegisteredLibraries() external view returns (address[] memory);
    function defaultSendLibrary(uint32 eid) external view returns (address);
}

interface IMessageLibLite {
    function messageLibType() external view returns (uint8);
    function version() external view returns (uint64, uint8, uint8);
}

/// @notice Robinhood Chain fork checks for the cross-chain plumbing: the real TJAR factory, and whether LayerZero
///         lzRead exists there. Skips unless FORK_RPC is set (never commit it).
contract TjarForkTest is Test {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant TJAR_FACTORY = 0xfAc70EEEE259F2140CBbB8e3157b75A52ce39fee;
    address internal constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant LZ_ENDPOINT_V2 = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    /// @dev STRATEGY / MSTR v4 pool on Robinhood, used only as a live price source for a same-chain pool.
    bytes32 internal constant SRC_ID = 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0;

    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        if (block.chainid != 4663) return; // Robinhood Chain only
        forked = true;
        emit log_named_uint("forked at block", block.number);
    }

    /// @notice Reports whether LayerZero lzRead can be used from Robinhood Chain: a read message library must be
    ///         registered on the endpoint. Logs only; does not fail.
    function test_fork_lzReadAvailability() public {
        if (!forked) return;
        IEndpointV2Lite ep = IEndpointV2Lite(LZ_ENDPOINT_V2);
        emit log_named_uint("endpoint eid", ep.eid());
        address[] memory libs = ep.getRegisteredLibraries();
        bool readLib;
        for (uint256 i = 0; i < libs.length; i++) {
            (uint64 major,,) = IMessageLibLite(libs[i]).version();
            uint8 t;
            try IMessageLibLite(libs[i]).messageLibType() returns (uint8 x) {
                t = x;
            } catch {}
            emit log_named_address("registered lib", libs[i]);
            emit log_named_uint("  type (0 send, 1 receive, 2 both)", t);
            emit log_named_uint("  major version", major);
            // ReadLib1002 is a send-and-receive lib at major version 10 (blocked lib reports uint64 max)
            if (t == 2 && major == 10) readLib = true;
        }
        emit log_named_address("default send lib, read channel 4294967295", ep.defaultSendLibrary(4294967295));
        emit log_named_address("default send lib, Ethereum (30101)", ep.defaultSendLibrary(30101));
        emit log_string(readLib ? "lzRead: AVAILABLE" : "lzRead: NOT AVAILABLE on this endpoint (keep mock)");
    }

    // -----------------------------------------------------------------------------------------

    function _pool() internal returns (DiscipleHook hook, PoolId id, MockERC20 coin) {
        IPoolManager m = IPoolManager(RH_POOL_MANAGER);
        coin = new MockERC20("COIN", "COIN", 18);
        MockERC20 quote = new MockERC20("QUOTE", "QUOTE", 18);
        bytes memory args = abi.encode(
            m,
            address(0xB1D6E),
            address(0),
            address(0),
            address(0),
            DiscipleHook.Config(10_000, address(0), 0, address(0), bytes32(0), false)
        );
        hook = new DiscipleHook{salt: _mine(args)}(
            m,
            address(0xB1D6E),
            address(0),
            address(0),
            address(0),
            DiscipleHook.Config(10_000, address(0), 0, address(0), bytes32(0), false)
        );
        coin.mint(address(this), 1e30);
        quote.mint(address(this), 1e30);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        DiscipleHook.Source memory s;
        // a push-priced pool (tanks only matter cross chain; 0xB1D6E stands in for the receiver); it never goes live here, the tank still fills
        s.kind = 3;
        s.coinIs0 = true;
        s.target = RH_POOL_MANAGER;
        s.v4Id = SRC_ID;
        s.remoteEid = 30101;
        s.push = true;
        (, id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(quote),
                fee: 3000,
                src: s,
                coinIn: 1000e18,
                quoteIn: 1e28,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
    }

    function _mine(bytes memory args) internal view returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(DiscipleHook).creationCode, args));
        for (uint256 i = 0; i < 3_000_000; i++) {
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(i), initHash))))
            );
            if (uint160(a) & Hooks.ALL_HOOK_MASK == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";
import {MockERC20} from "../bridge/mocks/BridgeMocks.sol";

interface IPairTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IDec {
    function decimals() external view returns (uint8);
}

/// @notice Fork test: a Disciple pool beside each real source pool, priced off its live state, swapped both ways and
///         deposited into. Skips unless FORK_RPC is set. Run it once per chain.
///
///         The Disciple pool's own two tokens are stand-in ERC20s with the source tokens' decimals (so odd real
///         tokens, native ETH legs or tokens `deal` cannot mint never block the run). Prices come from the real
///         source pool; that is what this test exercises.
///
///         Env:
///           FORK_RPC          the chain's RPC (never commit it)
///           FORK_V2           comma list of v2 pair addresses (optional)
///           FORK_V3           comma list of v3 pool addresses (optional)
///           FORK_V4_IDS       comma list of v4 pool ids (optional; tokens found from the Initialize event)
///           FORK_V4_MANAGER   the chain's v4 PoolManager (defaults to Robinhood Chain's)
///           FORK_BLOCK        block to fork at (optional, default latest)
contract DiscipleForkTest is Test {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant Q128 = 1 << 128;
    /// @dev Uniswap v4 PoolManager on Robinhood Chain (4663), deployed at block 9070.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 internal constant RH_PM_BLOCK = 9070;
    bytes32 internal constant INITIALIZE_TOPIC =
        keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");

    bool forked;
    uint256 failures;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;
        emit log_named_uint("chain id", block.chainid);
        emit log_named_uint("forked at block", block.number);
    }

    function test_fork_v2Sources() public {
        if (!forked) return;
        address[] memory pairs = vm.envOr("FORK_V2", ",", new address[](0));
        IPoolManager m = IPoolManager(address(new PoolManager(address(this))));
        for (uint256 i = 0; i < pairs.length; i++) {
            address t0 = IPairTokens(pairs[i]).token0();
            address t1 = IPairTokens(pairs[i]).token1();
            Disciple.Source memory s;
            s.kind = 1;
            s.v2Fee = 3000;
            s.target = pairs[i];
            _run(m, s, t0, t1, vm.toString(pairs[i]));
        }
    }

    function test_fork_v3Sources() public {
        if (!forked) return;
        address[] memory pools = vm.envOr("FORK_V3", ",", new address[](0));
        IPoolManager m = IPoolManager(address(new PoolManager(address(this))));
        for (uint256 i = 0; i < pools.length; i++) {
            address t0 = IPairTokens(pools[i]).token0();
            address t1 = IPairTokens(pools[i]).token1();
            Disciple.Source memory s;
            s.kind = 2;
            s.target = pools[i];
            _run(m, s, t0, t1, vm.toString(pools[i]));
        }
    }

    function test_fork_v4Sources() public {
        if (!forked) return;
        bytes32[] memory ids = vm.envOr("FORK_V4_IDS", ",", new bytes32[](0));
        if (ids.length == 0) return;
        // the hook reads v4 sources through its own PoolManager, so it must sit on the chain's real one
        address pm = vm.envOr("FORK_V4_MANAGER", RH_POOL_MANAGER);
        require(pm.code.length > 0, "no PoolManager at FORK_V4_MANAGER on this chain");
        for (uint256 i = 0; i < ids.length; i++) {
            (address c0, address c1) = _v4Tokens(pm, ids[i]);
            Disciple.Source memory s;
            s.kind = 3;
            s.target = pm;
            s.v4Id = ids[i];
            _run(IPoolManager(pm), s, c0, c1, vm.toString(ids[i]));
        }
    }

    // -----------------------------------------------------------------------------------------

    /// @dev currency0 / currency1 of a v4 pool from its Initialize event.
    function _v4Tokens(address pm, bytes32 id) internal view returns (address c0, address c1) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = INITIALIZE_TOPIC;
        topics[1] = id;
        uint256 from = pm == RH_POOL_MANAGER ? RH_PM_BLOCK : 0;
        Vm.EthGetLogs[] memory logs = vm.eth_getLogs(from, block.number, pm, topics);
        require(logs.length == 1, "v4 pool id not found on this PoolManager");
        c0 = address(uint160(uint256(logs[0].topics[2])));
        c1 = address(uint160(uint256(logs[0].topics[3])));
    }

    function _dec(address t) internal view returns (uint8) {
        if (t == address(0)) return 18; // native ETH
        return IDec(t).decimals();
    }

    function _sym(address t) internal view returns (string memory) {
        if (t == address(0)) return "ETH";
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature("symbol()"));
        return ok && r.length >= 64 ? abi.decode(r, (string)) : vm.toString(t);
    }

    /// @dev Coin = source token0, quote = token1. A fresh hook per source (the quote token is a hook immutable).
    function _run(IPoolManager m, Disciple.Source memory s, address t0, address t1, string memory label) internal {
        emit log_string(string.concat("---- source ", label, "  ", _sym(t0), " / ", _sym(t1)));
        uint8 cd = _dec(t0);
        uint8 qd = _dec(t1);
        s.coinIs0 = true;
        MockERC20 coin = new MockERC20("COIN", "COIN", cd);
        MockERC20 quote = new MockERC20("QUOTE", "QUOTE", qd);
        bytes memory args = abi.encode(m, address(quote), ILzRead(address(0)));
        Disciple hook = new Disciple{salt: _mine(args)}(m, address(quote), ILzRead(address(0)));
        PoolSwapTest swapper = new PoolSwapTest(m);
        coin.mint(address(this), type(uint128).max);
        quote.mint(address(this), type(uint128).max);
        coin.approve(address(hook), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);

        // seed: 1,000 whole coins and plenty of quote (trimmed to 50/50 at the source price)
        (PoolKey memory key, PoolId id) = hook.createPool(
            Disciple.CreateParams({
                coin: address(coin),
                fee: 3000,
                src: s,
                coinIn: 1000 * 10 ** cd,
                quoteIn: type(uint128).max / 4
            })
        );
        Disciple.PoolView memory v = hook.poolState(id);
        uint256 a = v.anchorX128;
        emit log_named_decimal_uint("  source price (quote per coin)", _human(a, cd, qd), 18);
        emit log_named_decimal_uint("  seed coin", v.coinReserve, cd);
        emit log_named_decimal_uint("  seed quote", v.quoteReserve, qd);
        assertGt(a, 0);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 60); // premium faded

        // buy with 1% of the quote reserve, then sell 1% of the coin reserve
        uint256 qIn = v.quoteReserve / 100;
        uint256 b0 = coin.balanceOf(address(this));
        uint256 g = gasleft();
        _swap(swapper, key, address(coin), true, qIn);
        emit log_named_uint("  buy gas (incl. router)", g - gasleft());
        uint256 got = coin.balanceOf(address(this)) - b0;
        uint256 paid = Math.mulDiv(qIn, Q128, got);
        emit log_named_decimal_uint("  buy price", _human(paid, cd, qd), 18);
        assertGe(paid, a, "buy at or above the source price");
        assertLe(paid, Math.mulDiv(a, 105, 100), "buy within 5% of the source price");

        uint256 cIn = v.coinReserve / 100;
        b0 = quote.balanceOf(address(this));
        _swap(swapper, key, address(coin), false, cIn);
        uint256 recv = Math.mulDiv(quote.balanceOf(address(this)) - b0, Q128, cIn);
        emit log_named_decimal_uint("  sell price", _human(recv, cd, qd), 18);
        assertLe(recv, a, "sell at or below the source price");
        assertGe(recv, Math.mulDiv(a, 95, 100), "sell within 5% of the source price");

        // an LP joins and leaves in the next block
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        (uint256 lot, uint256 sh) = hook.deposit(id, v.coinReserve / 10, type(uint128).max / 8);
        hook.withdraw(id, lot, sh, 0);
        v = hook.poolState(id);
        emit log_named_decimal_uint("  end coin", v.coinReserve, cd);
        emit log_named_decimal_uint("  end quote", v.quoteReserve, qd);
    }

    function _swap(PoolSwapTest swapper, PoolKey memory key, address c, bool buy, uint256 amtIn) internal {
        bool coinIs0 = Currency.unwrap(key.currency0) == c;
        bool zeroForOne = buy ? !coinIs0 : coinIs0;
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amtIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev X128 raw price to quote-per-coin in whole units, WAD.
    function _human(uint256 x128, uint8 cd, uint8 qd) internal pure returns (uint256) {
        return Math.mulDiv(x128, 1e18 * 10 ** cd, Q128 * 10 ** qd);
    }

    function _mine(bytes memory args) internal view returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(Disciple).creationCode, args));
        for (uint256 i = 0; i < 3_000_000; i++) {
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(i), initHash))))
            );
            if (uint160(a) & Hooks.ALL_HOOK_MASK == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }
}

/// @notice Stand-in v2 pair for a local dry run of this fork test (anvil). Not used on Robinhood.
contract ForkDryRunPair {
    address public token0;
    address public token1;
    uint112 internal r0;
    uint112 internal r1;

    constructor(address a, address b, uint112 ra, uint112 rb) {
        (token0, token1, r0, r1) = (a, b, ra, rb);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }
}

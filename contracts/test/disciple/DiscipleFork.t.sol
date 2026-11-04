// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {ILzRead} from "../../src/bridge/interfaces/ILzRead.sol";

interface IPairTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IDec {
    function decimals() external view returns (uint8);
}

/// @notice Fork test on Robinhood Chain: a Disciple pool beside each real source pool, swapped both ways and
///         deposited into against live state. Skips unless ROBINHOOD_RPC_URL is set.
///
///         Env:
///           ROBINHOOD_RPC_URL   the RPC (never commit it)
///           FORK_QUOTE          the quote token (e.g. WETH or a stablecoin)
///           FORK_V2             comma list of v2 pair addresses (optional)
///           FORK_V3             comma list of v3 pool addresses (optional)
///           FORK_V4_MANAGER     the chain's v4 PoolManager (needed for v4 sources; else a fresh one is deployed)
///           FORK_V4_IDS         comma list of v4 pool ids (optional, with FORK_V4_COINS in the same order)
///           FORK_V4_COINS       the non-quote token of each v4 pool
///           FORK_BLOCK          block to fork at (optional, default latest)
contract DiscipleForkTest is Test {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant Q128 = 1 << 128;

    IPoolManager manager;
    Disciple hook;
    PoolSwapTest swapper;
    address quote;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;
        quote = vm.envAddress("FORK_QUOTE");
        address m = vm.envOr("FORK_V4_MANAGER", address(0));
        manager = m == address(0) ? IPoolManager(address(new PoolManager(address(this)))) : IPoolManager(m);
        bytes memory args = abi.encode(manager, quote, ILzRead(address(0)));
        hook = new Disciple{salt: _mine(args)}(manager, quote, ILzRead(address(0)));
        swapper = new PoolSwapTest(manager);
        emit log_named_uint("forked at block", block.number);
    }

    function test_fork_v2Sources() public {
        if (!forked) return;
        address[] memory pairs = vm.envOr("FORK_V2", ",", new address[](0));
        for (uint256 i = 0; i < pairs.length; i++) {
            _runPair(1, pairs[i]);
        }
    }

    function test_fork_v3Sources() public {
        if (!forked) return;
        address[] memory pools = vm.envOr("FORK_V3", ",", new address[](0));
        for (uint256 i = 0; i < pools.length; i++) {
            _runPair(2, pools[i]);
        }
    }

    function test_fork_v4Sources() public {
        if (!forked) return;
        bytes32[] memory ids = vm.envOr("FORK_V4_IDS", ",", new bytes32[](0));
        if (ids.length == 0) return;
        address[] memory coins = vm.envAddress("FORK_V4_COINS", ",");
        require(coins.length == ids.length, "FORK_V4_COINS must match FORK_V4_IDS");
        require(vm.envOr("FORK_V4_MANAGER", address(0)) != address(0), "v4 sources need FORK_V4_MANAGER");
        for (uint256 i = 0; i < ids.length; i++) {
            Disciple.Source memory s;
            s.kind = 3;
            s.coinIs0 = coins[i] < quote;
            s.target = address(manager);
            s.v4Id = ids[i];
            _run(coins[i], s, vm.toString(ids[i]));
        }
    }

    // -----------------------------------------------------------------------------------------

    function _runPair(uint8 kind, address src) internal {
        address t0 = IPairTokens(src).token0();
        address t1 = IPairTokens(src).token1();
        require(t0 == quote || t1 == quote, "source does not hold FORK_QUOTE");
        address c = t0 == quote ? t1 : t0;
        Disciple.Source memory s;
        s.kind = kind;
        s.coinIs0 = c == t0;
        s.v2Fee = 3000;
        s.target = src;
        _run(c, s, vm.toString(src));
    }

    function _run(address c, Disciple.Source memory s, string memory label) internal {
        emit log_string(string.concat("---- source ", label));
        uint8 cd = IDec(c).decimals();
        uint8 qd = IDec(quote).decimals();
        // seed: 1,000 whole coins and plenty of quote (trimmed to 50/50 by the hook)
        uint256 coinIn = 1000 * 10 ** cd;
        deal(c, address(this), coinIn * 10);
        deal(quote, address(this), type(uint128).max);
        IERC20Minimal(c).approve(address(hook), type(uint256).max);
        IERC20Minimal(quote).approve(address(hook), type(uint256).max);
        IERC20Minimal(c).approve(address(swapper), type(uint256).max);
        IERC20Minimal(quote).approve(address(swapper), type(uint256).max);

        (PoolKey memory key, PoolId id) = hook.createPool(
            Disciple.CreateParams({coin: c, fee: 3000, src: s, coinIn: coinIn, quoteIn: type(uint128).max / 4})
        );
        Disciple.PoolView memory v = hook.poolState(id);
        uint256 a = v.anchorX128;
        emit log_named_decimal_uint("  anchor (quote per coin)", _human(a, cd, qd), 18);
        emit log_named_decimal_uint("  seed coin", v.coinReserve, cd);
        emit log_named_decimal_uint("  seed quote", v.quoteReserve, qd);
        assertGt(a, 0);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 60); // premium faded

        // buy with 1% of the quote reserve, sell 1% of the coin reserve
        uint256 qIn = v.quoteReserve / 100;
        uint256 c0 = IERC20Minimal(c).balanceOf(address(this));
        uint256 g = gasleft();
        _swap(key, c, true, qIn);
        emit log_named_uint("  buy gas (incl. router)", g - gasleft());
        uint256 got = IERC20Minimal(c).balanceOf(address(this)) - c0;
        uint256 paidPerCoin = Math.mulDiv(qIn, Q128, got);
        emit log_named_decimal_uint("  buy price", _human(paidPerCoin, cd, qd), 18);
        assertGe(paidPerCoin, a, "buy at or above the anchor");
        assertLe(paidPerCoin, Math.mulDiv(a, 105, 100), "buy within 5% of the anchor");

        uint256 cIn = v.coinReserve / 100;
        uint256 q0 = IERC20Minimal(quote).balanceOf(address(this));
        _swap(key, c, false, cIn);
        uint256 qGot = IERC20Minimal(quote).balanceOf(address(this)) - q0;
        uint256 recvPerCoin = Math.mulDiv(qGot, Q128, cIn);
        emit log_named_decimal_uint("  sell price", _human(recvPerCoin, cd, qd), 18);
        assertLe(recvPerCoin, a, "sell at or below the anchor");
        assertGe(recvPerCoin, Math.mulDiv(a, 95, 100), "sell within 5% of the anchor");

        // an LP joins and leaves in the next block
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        (uint256 lot, uint256 sh) = hook.deposit(id, v.coinReserve / 10, type(uint128).max / 8);
        hook.withdraw(id, lot, sh, 0);
        v = hook.poolState(id);
        emit log_named_decimal_uint("  end coin", v.coinReserve, cd);
        emit log_named_decimal_uint("  end quote", v.quoteReserve, qd);
    }

    function _swap(PoolKey memory key, address c, bool buy, uint256 amtIn) internal {
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

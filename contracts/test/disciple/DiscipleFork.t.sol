// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
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

interface IERC20Lite {
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IV2Swap {
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address, bytes calldata) external;
}

interface IV3Swap {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

/// @notice Fork test: a Disciple pool beside each real source pool, using the source's REAL tokens (a native-ETH
///         leg becomes the chain's WETH, since Disciple pools are ERC20 only). For each source it:
///           1. quotes Disciple and the source at the same size, both directions, from the same state (snapshots):
///              the source side is a real executed swap through the source itself, so hook fee overrides count;
///           2. asserts no round trip between Disciple and the source is profitable at that size;
///           3. runs an LP through same-block and next-block deposit/withdraw;
///           4. asserts conservation: the hook's ERC-6909 claims cover the pool's books exactly.
///         Skips unless FORK_RPC is set. Run it once per chain.
///
///         Env:
///           FORK_RPC          the chain's RPC (never commit it)
///           FORK_V2           comma list of v2 pair addresses (optional)
///           FORK_V3           comma list of v3 pool addresses (optional)
///           FORK_V4_IDS       comma list of v4 pool ids (optional; key found from the Initialize event)
///           FORK_V4_MANAGER   the chain's v4 PoolManager (defaults to Robinhood Chain's)
///           FORK_V4_INIT_BLOCKS  each v4 pool's Initialize block, same order (optional; for capped eth_getLogs)
///           FORK_WETH         the chain's WETH (defaults: Robinhood, Ethereum)
///           FORK_BLOCK        block to fork at (optional, default latest)
contract DiscipleForkTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant Q128 = 1 << 128;
    /// @dev Uniswap v4 PoolManager on Robinhood Chain (4663), deployed at block 9070.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 internal constant RH_PM_BLOCK = 9070;
    address internal constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ETH_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    bytes32 internal constant INITIALIZE_TOPIC =
        keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");

    /// @dev What one run needs to execute against the source.
    struct Src {
        uint8 kind;
        address target; // pair / pool / PoolManager
        PoolKey v4Key; // v4 only
        address t0; // real source tokens (address(0) = native ETH)
        address t1;
    }

    struct Quotes {
        uint256 disBuy; // quote paid per coin, X128 raw
        uint256 disSell; // quote received per coin
        uint256 srcBuy;
        uint256 srcSell;
        bool srcBuyOk;
        bool srcSellOk;
    }

    bool forked;

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
            Src memory x;
            x.kind = 1;
            x.target = pairs[i];
            x.t0 = IPairTokens(pairs[i]).token0();
            x.t1 = IPairTokens(pairs[i]).token1();
            _run(m, x, vm.toString(pairs[i]));
        }
    }

    function test_fork_v3Sources() public {
        if (!forked) return;
        address[] memory pools = vm.envOr("FORK_V3", ",", new address[](0));
        IPoolManager m = IPoolManager(address(new PoolManager(address(this))));
        for (uint256 i = 0; i < pools.length; i++) {
            Src memory x;
            x.kind = 2;
            x.target = pools[i];
            x.t0 = IPairTokens(pools[i]).token0();
            x.t1 = IPairTokens(pools[i]).token1();
            _run(m, x, vm.toString(pools[i]));
        }
    }

    function test_fork_v4Sources() public {
        if (!forked) return;
        bytes32[] memory ids = vm.envOr("FORK_V4_IDS", ",", new bytes32[](0));
        if (ids.length == 0) return;
        // the hook reads v4 sources through its own PoolManager, so it must sit on the chain's real one
        address pm = vm.envOr("FORK_V4_MANAGER", RH_POOL_MANAGER);
        require(pm.code.length > 0, "no PoolManager at FORK_V4_MANAGER on this chain");
        // optional: each pool's Initialize block, for RPC plans that cap eth_getLogs ranges (Alchemy free: 10 blocks)
        uint256[] memory initBlocks = vm.envOr("FORK_V4_INIT_BLOCKS", ",", new uint256[](0));
        for (uint256 i = 0; i < ids.length; i++) {
            Src memory x;
            x.kind = 3;
            x.target = pm;
            x.v4Key = _v4Key(pm, ids[i], initBlocks.length > i ? initBlocks[i] : 0);
            x.t0 = Currency.unwrap(x.v4Key.currency0);
            x.t1 = Currency.unwrap(x.v4Key.currency1);
            _run(IPoolManager(pm), x, vm.toString(ids[i]));
        }
    }

    // -----------------------------------------------------------------------------------------
    // one source
    // -----------------------------------------------------------------------------------------

    /// @dev Coin = source token0, quote = token1. A fresh hook per source (the quote token is a hook immutable).
    function _run(IPoolManager m, Src memory x, string memory label) internal {
        emit log_string(string.concat("---- source ", label, "  ", _sym(x.t0), " / ", _sym(x.t1)));
        address coin = _erc20(x.t0);
        address quote = _erc20(x.t1);
        uint8 cd = IDec(coin).decimals();
        uint8 qd = IDec(quote).decimals();

        Disciple.Source memory s;
        s.kind = x.kind;
        s.coinIs0 = true; // the source's token0 is our coin
        s.v2Fee = 3000;
        s.target = x.target;
        s.v4Id = x.kind == 3 ? PoolId.unwrap(x.v4Key.toId()) : bytes32(0);

        bytes memory args = abi.encode(m, quote, ILzRead(address(0)), address(0), address(0));
        Disciple hook = new Disciple{salt: _mine(args)}(m, quote, ILzRead(address(0)), address(0), address(0));
        PoolSwapTest swapper = new PoolSwapTest(m);
        _fund(coin, quote, address(hook), address(swapper));

        uint256 coinSeed = 1000 * 10 ** cd;
        (PoolKey memory key, PoolId id) = hook.createPool(
            Disciple.CreateParams({coin: coin, fee: 3000, src: s, coinIn: coinSeed, quoteIn: _bal(quote) / 4})
        );
        Disciple.PoolView memory v = hook.poolState(id);
        emit log_named_decimal_uint("  source spot (quote per coin)", _human(v.anchorX128, cd, qd), 18);
        emit log_named_decimal_uint("  seed coin", v.coinReserve, cd);
        emit log_named_decimal_uint("  seed quote", v.quoteReserve, qd);
        assertGt(v.anchorX128, 0);
        _conserve(m, hook, id, coin, quote);

        vm.roll(block.number + 1);
        vm.warp(vm.getBlockTimestamp() + 60); // premium faded

        // 1-2. matched-size quotes, all from this same state
        uint256 qIn = v.quoteReserve / 100;
        uint256 cIn = v.coinReserve / 100;
        Quotes memory q = _quotes(swapper, key, hook, x, coin, quote, qIn, cIn);
        emit log_named_decimal_uint("  disciple buy", _human(q.disBuy, cd, qd), 18);
        emit log_named_decimal_uint("  disciple sell", _human(q.disSell, cd, qd), 18);
        if (q.srcBuyOk) emit log_named_decimal_uint("  source buy (executed)", _human(q.srcBuy, cd, qd), 18);
        else emit log_string("  source buy: source swap reverted (router or hook restriction)");
        if (q.srcSellOk) emit log_named_decimal_uint("  source sell (executed)", _human(q.srcSell, cd, qd), 18);
        else emit log_string("  source sell: source swap reverted (router or hook restriction)");
        assertGe(q.disBuy, q.disSell, "Disciple ask >= bid");
        // 2. no profitable round trip: real two-leg trades, the first leg's exact output fed into the second
        _arbs(swapper, key, x, coin, quote, v.coinReserve, v.quoteReserve);

        // actually trade both ways so the books move, then check conservation
        _swap(swapper, key, coin, true, qIn);
        _swap(swapper, key, coin, false, cIn);
        _conserve(m, hook, id, coin, quote);

        // 3. LP accounting
        _lpChecks(m, hook, swapper, key, id, coin, quote, qIn);

        // 4. conservation after everything
        _conserve(m, hook, id, coin, quote);
        v = hook.poolState(id);
        emit log_named_decimal_uint("  end coin", v.coinReserve, cd);
        emit log_named_decimal_uint("  end quote", v.quoteReserve, qd);
    }

    function _quotes(
        PoolSwapTest swapper,
        PoolKey memory key,
        Disciple,
        Src memory x,
        address coin,
        address quote,
        uint256 qIn,
        uint256 cIn
    ) internal returns (Quotes memory q) {
        uint256 snap = vm.snapshotState();
        uint256 b0 = _bal(coin);
        _swap(swapper, key, coin, true, qIn);
        q.disBuy = Math.mulDiv(qIn, Q128, _bal(coin) - b0);
        vm.revertToState(snap);
        snap = vm.snapshotState();
        b0 = _bal(quote);
        _swap(swapper, key, coin, false, cIn);
        q.disSell = Math.mulDiv(_bal(quote) - b0, Q128, cIn);
        vm.revertToState(snap);

        snap = vm.snapshotState();
        (bool ok, uint256 out) = _srcSwap(x, false, qIn); // pay token1 (quote), get coin
        if (ok && out > 0) (q.srcBuyOk, q.srcBuy) = (true, Math.mulDiv(qIn, Q128, out));
        vm.revertToState(snap);
        snap = vm.snapshotState();
        (ok, out) = _srcSwap(x, true, cIn); // pay token0 (coin), get quote
        if (ok && out > 0) (q.srcSellOk, q.srcSell) = (true, Math.mulDiv(out, Q128, cIn));
        vm.revertToState(snap);
    }


    // -----------------------------------------------------------------------------------------
    // two-leg arbitrage
    // -----------------------------------------------------------------------------------------

    /// @dev Every ordering at three sizes (0.1%, 1%, 5% of the Disciple side being drained), each from the same
    ///      state, within one block, in two states: Disciple untouched this block (the first leg latches it) and
    ///      Disciple already touched (latched before the source moves). Leg 2 spends exactly leg 1's output.
    ///      Native-ETH legs count WETH and ETH at par.
    function _arbs(
        PoolSwapTest swapper,
        PoolKey memory key,
        Src memory x,
        address coin,
        address quote,
        uint256 cr,
        uint256 qr
    ) internal {
        uint16[3] memory bps = [uint16(10), 100, 500];
        for (uint256 w = 0; w < 2; w++) {
            for (uint256 i = 0; i < 3; i++) {
                uint256 qIn = qr * bps[i] / 10_000;
                uint256 cIn = cr * bps[i] / 10_000;
                for (uint8 order = 0; order < 4; order++) {
                    uint256 snap = vm.snapshotState();
                    if (w == 1) _swap(swapper, key, coin, true, qr / 1_000_000 + 1); // touch Disciple first
                    (bool ok, uint256 start, uint256 end) = _arb(swapper, key, x, coin, quote, order, qIn, cIn);
                    vm.revertToState(snap);
                    if (!ok) {
                        emit log_named_uint("  arb skipped (source leg reverted), order", order);
                        continue;
                    }
                    if (i == 1 && w == 0) {
                        emit log_named_uint("  arb order", order);
                        emit log_named_decimal_uint("    end / start at 1% size (1e18 = flat)", end * 1e18 / start, 18);
                    }
                    assertLe(end, start, "two-leg round trip must not end with more of the starting token");
                }
            }
        }
    }

    /// @dev order 0: quote -> Disciple buy -> source sell -> quote
    ///      order 1: quote -> source buy -> Disciple sell -> quote
    ///      order 2: coin -> Disciple sell -> source buy -> coin
    ///      order 3: coin -> source sell -> Disciple buy -> coin
    function _arb(
        PoolSwapTest swapper,
        PoolKey memory key,
        Src memory x,
        address coin,
        address quote,
        uint8 order,
        uint256 qIn,
        uint256 cIn
    ) internal returns (bool ok, uint256 start, uint256 end) {
        uint256 mid;
        if (order == 0) {
            start = qIn;
            mid = _disSwap(swapper, key, coin, quote, true, qIn);
            (ok, end) = _srcSwap(x, true, mid);
        } else if (order == 1) {
            start = qIn;
            (ok, mid) = _srcSwap(x, false, qIn);
            if (ok && mid > 0) end = _disSwap(swapper, key, coin, quote, false, mid);
        } else if (order == 2) {
            start = cIn;
            mid = _disSwap(swapper, key, coin, quote, false, cIn);
            (ok, end) = _srcSwap(x, false, mid);
        } else {
            start = cIn;
            (ok, mid) = _srcSwap(x, true, cIn);
            if (ok && mid > 0) end = _disSwap(swapper, key, coin, quote, true, mid);
        }
        ok = ok && mid > 0;
    }

    /// @dev Exact-in on Disciple; returns the output from this contract's balance change.
    function _disSwap(PoolSwapTest swapper, PoolKey memory key, address coin, address quote, bool buy, uint256 amtIn)
        internal
        returns (uint256)
    {
        address outT = buy ? coin : quote;
        uint256 b0 = _bal(outT);
        _swap(swapper, key, coin, buy, amtIn);
        return _bal(outT) - b0;
    }

    // -----------------------------------------------------------------------------------------
    // LP accounting
    // -----------------------------------------------------------------------------------------

    /// @dev (a) No-trade control: deposit, next block, withdraw. Loss bounded in token units (<= 1 wei per token:
    ///          one ceil on the deposit, one floor on the withdrawal).
    ///      (b) Known profitable flow: an LP joins behind the creator, a trader round-trips on Disciple (pays the
    ///          spread twice, coin flow nets to zero so the earning is exact in quote), next block settles. The LP's
    ///          entitlement = its principal's pro-rata value + its boost-weighted share of the earning, where weights
    ///          are the line's slide F(z) = 7z - 2.9z^2/S (no compound class yet). Asserted against the books and
    ///          then the tokens actually paid.
    ///      (c) Full reconciliation by draining: every lot withdraws principal and compound balance (and claims,
    ///          if graduated); total paid out + what is left equals total paid in, token by token, and the hook's
    ///          claims equal what is left.
    function _lpChecks(
        IPoolManager m,
        Disciple hook,
        PoolSwapTest swapper,
        PoolKey memory key,
        PoolId id,
        address coin,
        address quote,
        uint256 qIn
    ) internal {
        Disciple.PoolView memory v = hook.poolState(id);
        address lp = makeAddr("lp");
        _give(lp, coin, quote, address(hook), v.coinReserve, v.quoteReserve);

        // (a) no-trade control
        _nextBlockSame();
        uint256 c0 = IERC20Lite(coin).balanceOf(lp);
        uint256 q0 = IERC20Lite(quote).balanceOf(lp);
        vm.prank(lp);
        (uint256 lot, uint256 sh) = hook.deposit(id, v.coinReserve / 10, v.quoteReserve / 10);
        _nextBlockSame();
        vm.prank(lp);
        hook.withdraw(id, lot, sh, 0);
        uint256 lossC = c0 - IERC20Lite(coin).balanceOf(lp);
        uint256 lossQ = q0 - IERC20Lite(quote).balanceOf(lp);
        emit log_named_uint("  LP no-trade control: coin lost (raw units)", lossC);
        emit log_named_uint("  LP no-trade control: quote lost (raw units)", lossQ);
        assertLe(lossC, 1, "no-trade rounding <= 1 wei coin");
        assertLe(lossQ, 1, "no-trade rounding <= 1 wei quote");
        (, uint256 cs, uint256 cb,,) = hook.lotState(id, lot);
        assertEq(cs + cb, 0, "nothing left behind");

        // (b) known profitable flow
        _nextBlockSame();
        v = hook.poolState(id);
        uint256 sp = v.principal; // principal ahead of the LP in the line
        uint256 b = v.compounded; // compound class (earlier earnings), weighted a flat 1.2x
        vm.prank(lp);
        (lot, sh) = hook.deposit(id, v.coinReserve / 4, v.quoteReserve / 4);
        _nextBlockSame();
        uint256 qb = _bal(quote);
        uint256 got = _disSwap(swapper, key, coin, quote, true, qIn);
        _disSwap(swapper, key, coin, quote, false, got); // coin back exactly: dx = 0
        uint256 earn = qb - _bal(quote); // what the trader lost = the pool's earning, in quote
        emit log_named_uint("  known profitable flow: pool earned (quote raw)", earn);
        assertGt(earn, 0);
        _nextBlockSame();
        vm.prank(lp);
        hook.withdraw(id, lot, 0, 0); // first touch of the block settles the interval, moves nothing
        v = hook.poolState(id);
        uint256 vNow = Math.mulDiv(v.coinReserve, v.anchorX128, Q128) + v.quoteReserve;
        uint256 total = sp + sh; // S: all principal
        // LP's slice of the line: F(S) - F(sp), F(z) = 7z - 2.9 z^2 / S; the whole line weighs 4.1 S
        uint256 wLp = 7 * sh * 1e18 - Math.mulDiv(29e17, total * total - sp * sp, total);
        uint256 wAll = 41e17 * total + 12e17 * b;
        uint256 principalValue = Math.mulDiv(vNow - earn, sh, total + b);
        uint256 expected = principalValue + Math.mulDiv(earn, wLp, wAll);
        (, uint256 ls, uint256 lb,,) = hook.lotState(id, lot);
        uint256 st = v.principal + v.compounded;
        uint256 entitled = Math.mulDiv(vNow, ls + lb, st);
        emit log_named_decimal_uint("  LP entitlement / expected (1e18 = exact)", entitled * 1e18 / expected, 18);
        emit log_named_decimal_uint(
            "  LP share of the earning (boost-weighted)", Math.mulDiv(1e18, wLp, wAll), 18
        );
        assertApproxEqAbs(entitled, expected, 4 + expected / 1e12, "LP entitlement = pro-rata principal + weighted earning");
        assertLe(entitled, expected + 1, "rounding never favours the LP");
        c0 = IERC20Lite(coin).balanceOf(lp);
        q0 = IERC20Lite(quote).balanceOf(lp);
        vm.prank(lp);
        hook.withdraw(id, lot, ls, lb);
        uint256 paid = Math.mulDiv(IERC20Lite(coin).balanceOf(lp) - c0, v.anchorX128, Q128)
            + (IERC20Lite(quote).balanceOf(lp) - q0);
        assertApproxEqAbs(paid, entitled, 2 + entitled / 1e15, "tokens paid = entitlement");
        assertLe(paid, entitled + 1);
        _conserve(m, hook, id, coin, quote);

        // (c) graduate, earn, then drain everything and reconcile token by token
        _reconcile(m, hook, swapper, key, id, coin, quote, lp);
    }

    function _reconcile(
        IPoolManager m,
        Disciple hook,
        PoolSwapTest swapper,
        PoolKey memory key,
        PoolId id,
        address coin,
        address quote,
        address lp
    ) internal {
        Disciple.PoolView memory v = hook.poolState(id);
        // a deposit big enough to pass 12% of the source TVL, so the post-graduation books are exercised
        uint256 need = v.srcTvl * 13 / 100;
        uint256 have = Math.mulDiv(v.coinReserve, v.anchorX128, Q128) + v.quoteReserve;
        uint256 mult = need > have ? need / have + 1 : 1;
        _give(lp, coin, quote, address(hook), v.coinReserve * mult + 1, v.quoteReserve * mult + 1);
        _nextBlockSame();
        (uint256 lot,) = _dep(hook, id, lp, coin, quote, v.coinReserve * mult, v.quoteReserve * mult);
        _nextBlockSame();
        // profitable flow after graduation (graduation latches at this block's settle)
        for (uint256 r = 0; r < 3; r++) {
            uint256 got = _disSwap(swapper, key, coin, quote, true, v.quoteReserve / 50);
            _disSwap(swapper, key, coin, quote, false, got);
            _nextBlockSame();
        }
        vm.prank(lp);
        hook.withdraw(id, lot, 0, 0); // settle
        v = hook.poolState(id);
        emit log_named_string("  graduated", v.graduated ? "yes" : "no");
        // drain: LP lot, creator lot (keeps MIN_SHARES), claims, creator cut
        uint256 lots = v.lots;
        for (uint256 i = 1; i <= lots; i++) {
            (address owner, uint256 s, uint256 b,,) = hook.lotState(id, i);
            if (s + b == 0) {
                (,,, uint256 cx0, uint256 cy0) = hook.lotState(id, i);
                if (cx0 + cy0 > 0) {
                    vm.prank(owner);
                    hook.claim(id, i);
                }
                continue;
            }
            if (i == 1) s -= 1e6; // MIN_SHARES stay
            vm.startPrank(owner);
            hook.withdraw(id, i, s, b);
            (,,, uint256 cx, uint256 cy) = hook.lotState(id, i);
            if (cx + cy > 0) hook.claim(id, i);
            vm.stopPrank();
        }
        try hook.claimCreator(id) {} catch {} // reverts only when there is nothing to pay
        v = hook.poolState(id);
        uint256 hc2 = m.balanceOf(address(hook), uint256(uint160(coin)));
        uint256 hq2 = m.balanceOf(address(hook), uint256(uint160(quote)));
        // with every lot, claim and creator cut paid out, the claims left are the books left plus rounding dust
        // kept by the pool (escrow is reserved rounding up, paid out rounding down)
        assertGe(hc2, v.coinReserve, "after draining: coin claims cover the reserve");
        assertGe(hq2, v.quoteReserve, "after draining: quote claims cover the reserve");
        // Dust is counted in value: a share unit is one raw quote unit of value, so one share unit of rounding can
        // be many coin wei. Unowned value left must be a few raw quote units per payout.
        uint256 dustValue = Math.mulDiv(hc2 - v.coinReserve, v.anchorX128, Q128, Math.Rounding.Ceil)
            + (hq2 - v.quoteReserve);
        emit log_named_uint("  drained: unowned value (raw quote units)", dustValue);
        assertLe(dustValue, 2 * lots + 8, "only rounding dust unaccounted");
        emit log_named_uint("  drained: unowned coin dust (raw)", hc2 - v.coinReserve);
        emit log_named_uint("  drained: unowned quote dust (raw)", hq2 - v.quoteReserve);
        emit log_named_uint("  drained: coin left (raw)", hc2);
        emit log_named_uint("  drained: quote left (raw)", hq2);
    }

    function _dep(Disciple hook, PoolId id, address lp, address, address, uint256 c, uint256 q)
        internal
        returns (uint256 lot, uint256 sh)
    {
        vm.prank(lp);
        (lot, sh) = hook.deposit(id, c, q);
    }

    function _nextBlockSame() internal {
        vm.roll(block.number + 1);
        vm.warp(vm.getBlockTimestamp() + 60);
    }

    // -----------------------------------------------------------------------------------------
    // executing on the source itself
    // -----------------------------------------------------------------------------------------

    /// @dev Exact-in swap on the real source. `zeroForOne` pays token0. Returns the output amount.
    function _srcSwap(Src memory x, bool zeroForOne, uint256 amtIn) internal returns (bool ok, uint256 out) {
        if (x.kind == 1) return _v2Swap(x, zeroForOne, amtIn);
        if (x.kind == 2) return _v3Swap(x, zeroForOne, amtIn);
        return _v4Swap(x, zeroForOne, amtIn);
    }

    function _v2Swap(Src memory x, bool zeroForOne, uint256 amtIn) internal returns (bool, uint256 out) {
        (uint112 r0, uint112 r1,) = IV2Swap(x.target).getReserves();
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        out = (amtIn * 997 * rOut) / (rIn * 1000 + amtIn * 997); // standard 0.3% v2
        IERC20Lite(zeroForOne ? x.t0 : x.t1).transfer(x.target, amtIn);
        try IV2Swap(x.target).swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "") {
            return (true, out);
        } catch {
            return (false, 0);
        }
    }

    function _v3Swap(Src memory x, bool zeroForOne, uint256 amtIn) internal returns (bool, uint256) {
        try IV3Swap(x.target).swap(
            address(this),
            zeroForOne,
            int256(amtIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        ) returns (int256 d0, int256 d1) {
            return (true, uint256(-(zeroForOne ? d1 : d0)));
        } catch {
            return (false, 0);
        }
    }

    /// @dev v3 pays-in callback for `_v3Swap`.
    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (d0 > 0) IERC20Lite(IPairTokens(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        if (d1 > 0) IERC20Lite(IPairTokens(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }

    function _v4Swap(Src memory x, bool zeroForOne, uint256 amtIn) internal returns (bool, uint256) {
        PoolSwapTest sw = new PoolSwapTest(IPoolManager(x.target));
        if (x.t0 != address(0)) IERC20Lite(x.t0).approve(address(sw), type(uint256).max);
        IERC20Lite(x.t1).approve(address(sw), type(uint256).max);
        uint256 value = zeroForOne && x.t0 == address(0) ? amtIn : 0;
        try sw.swap{value: value}(
            x.v4Key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amtIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) returns (BalanceDelta d) {
            int128 o = zeroForOne ? d.amount1() : d.amount0();
            return (o > 0, o > 0 ? uint256(uint128(o)) : 0);
        } catch {
            return (false, 0);
        }
    }

    // -----------------------------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------------------------

    /// @dev The hook's claims hold exactly the pool's reserves (plus escrow and the creator's claim, which only
    ///      exist after graduation). One Disciple pool per hook here, so the claims are this pool's alone.
    function _conserve(IPoolManager m, Disciple hook, PoolId id, address coin, address quote) internal view {
        Disciple.PoolView memory v = hook.poolState(id);
        uint256 cc = m.balanceOf(address(hook), uint256(uint160(coin)));
        uint256 cq = m.balanceOf(address(hook), uint256(uint160(quote)));
        if (v.graduated) {
            assertGe(cc, v.coinReserve, "coin claims cover the books");
            assertGe(cq, v.quoteReserve, "quote claims cover the books");
        } else {
            assertEq(cc, v.coinReserve, "coin claims == coin reserve");
            assertEq(cq, v.quoteReserve, "quote claims == quote reserve");
        }
    }

    function _erc20(address t) internal view returns (address) {
        if (t != address(0)) return t;
        address w = vm.envOr("FORK_WETH", address(0));
        if (w != address(0)) return w;
        if (block.chainid == 4663) return RH_WETH;
        if (block.chainid == 1) return ETH_WETH;
        revert("native-ETH source: set FORK_WETH");
    }

    function _fund(address coin, address quote, address hook, address swapper) internal {
        deal(coin, address(this), type(uint128).max / 2);
        deal(quote, address(this), type(uint128).max / 2);
        vm.deal(address(this), 1e30);
        IERC20Lite(coin).approve(hook, type(uint256).max);
        IERC20Lite(quote).approve(hook, type(uint256).max);
        IERC20Lite(coin).approve(swapper, type(uint256).max);
        IERC20Lite(quote).approve(swapper, type(uint256).max);
    }

    function _give(address who, address coin, address quote, address hook, uint256 c, uint256 q) internal {
        IERC20Lite(coin).transfer(who, c);
        IERC20Lite(quote).transfer(who, q);
        vm.startPrank(who);
        IERC20Lite(coin).approve(hook, type(uint256).max);
        IERC20Lite(quote).approve(hook, type(uint256).max);
        vm.stopPrank();
    }

    function _value(address who, address coin, address quote, uint256 markX128) internal view returns (uint256) {
        return Math.mulDiv(IERC20Lite(coin).balanceOf(who), markX128, Q128) + IERC20Lite(quote).balanceOf(who);
    }

    function _bal(address t) internal view returns (uint256) {
        return IERC20Lite(t).balanceOf(address(this));
    }

    /// @dev The full v4 PoolKey from the pool's Initialize event.
    function _v4Key(address pm, bytes32 id, uint256 initBlock) internal view returns (PoolKey memory k) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = INITIALIZE_TOPIC;
        topics[1] = id;
        uint256 from = pm == RH_POOL_MANAGER ? RH_PM_BLOCK : 0;
        uint256 to = block.number;
        if (initBlock != 0) (from, to) = (initBlock, initBlock);
        Vm.EthGetLogs[] memory logs = vm.eth_getLogs(from, to, pm, topics);
        require(logs.length == 1, "v4 pool id not found on this PoolManager");
        (uint24 fee, int24 ts, address hooks,,) = abi.decode(logs[0].data, (uint24, int24, address, uint160, int24));
        k = PoolKey({
            currency0: Currency.wrap(address(uint160(uint256(logs[0].topics[2])))),
            currency1: Currency.wrap(address(uint160(uint256(logs[0].topics[3])))),
            fee: fee,
            tickSpacing: ts,
            hooks: IHooks(hooks)
        });
        require(PoolId.unwrap(k.toId()) == id, "rebuilt key does not hash to the pool id");
    }

    function _sym(address t) internal view returns (string memory) {
        if (t == address(0)) return "ETH";
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature("symbol()"));
        return ok && r.length >= 64 ? abi.decode(r, (string)) : vm.toString(t);
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

    receive() external payable {}
}

/// @notice Minimal v2 pair for a local dry run of this fork test (anvil). Not used on a real fork.
contract ForkDryRunPair {
    address public token0;
    address public token1;
    uint112 internal r0;
    uint112 internal r1;

    constructor(address a, address b) {
        (token0, token1) = (a, b);
    }

    function sync() external {
        r0 = uint112(IERC20Lite(token0).balanceOf(address(this)));
        r1 = uint112(IERC20Lite(token1).balanceOf(address(this)));
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        if (out0 > 0) IERC20Lite(token0).transfer(to, out0);
        if (out1 > 0) IERC20Lite(token1).transfer(to, out1);
        uint256 b0 = IERC20Lite(token0).balanceOf(address(this));
        uint256 b1 = IERC20Lite(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require((b0 * 1000 - in0 * 3) * (b1 * 1000 - in1 * 3) >= uint256(r0) * r1 * 1e6, "K");
        (r0, r1) = (uint112(b0), uint112(b1));
    }
}

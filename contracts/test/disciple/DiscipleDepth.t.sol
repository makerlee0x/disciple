// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {_noKey} from "./NoKey.sol";
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Disciple} from "../../src/disciple/Disciple.sol";
import {DiscipleDepth as DP} from "../../src/disciple/libraries/DiscipleDepth.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {DiscipleSourceReader} from "../../src/disciple/routes/DiscipleSourceReader.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract ReaderHarness is DiscipleSourceReader {
    function walk(uint8 kind, address target, bytes32 v4Id) external {
        _walk(kind, target, v4Id);
    }
}

contract V3Like {
    address public token0;
    address public token1;
    uint160 sqrtP;

    constructor(address a, address b, uint160 p) {
        (token0, token1, sqrtP) = (a, b, p);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtP, 0, 0, 0, 0, 0, true);
    }
}

contract WalkHarness {
    DP.Walk public w;

    constructor(int24 spacing) {
        w.spacing = spacing;
    }

    function step(IPoolManager pm, PoolId id, uint256 n) external {
        DP.step(w, pm, id, n);
    }

    function totals() external view returns (uint256, uint256, bool) {
        return (w.tot0, w.tot1, w.done);
    }
}

contract Pair2 {
    address public token0;
    address public token1;
    uint112 r0;
    uint112 r1;

    constructor(address a, address b) {
        (token0, token1) = (a, b);
    }

    function set(uint112 a, uint112 b) external {
        (r0, r1) = (a, b);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }
}

contract Factory2 {
    mapping(address => mapping(address => address)) public getPair;

    function add(Pair2 p) external {
        getPair[p.token0()][p.token1()] = address(p);
        getPair[p.token1()][p.token0()] = address(p);
    }
}

/// @notice The v4 depth counter against the real token amounts, the hook's use of it, its gas, and the reversible
///         creator cut.
contract DiscipleDepthTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant Q128 = 1 << 128;

    IPoolManager manager;
    PoolModifyLiquidityTest liq;
    PoolSwapTest swapper;
    MockERC20 coin;
    MockERC20 usd;
    Factory2 v2f;
    Disciple hook;

    function setUp() public {
        vm.roll(100);
        vm.warp(1_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        liq = new PoolModifyLiquidityTest(manager);
        swapper = new PoolSwapTest(manager);
        coin = new MockERC20("COIN", "COIN", 18);
        usd = new MockERC20("USD", "USD", 18);
        v2f = new Factory2();
        bytes memory args = abi.encode(manager, address(0), address(v2f), address(0), address(0));
        hook = new Disciple{salt: _mine(args)}(manager, address(0), address(v2f), address(0), address(0));
        coin.mint(address(this), 1e40);
        usd.mint(address(this), 1e40);
        coin.approve(address(liq), type(uint256).max);
        usd.approve(address(liq), type(uint256).max);
        coin.approve(address(swapper), type(uint256).max);
        usd.approve(address(swapper), type(uint256).max);
        coin.approve(address(hook), type(uint256).max);
        usd.approve(address(hook), type(uint256).max);
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

    function _srcKey(int24 spacing) internal view returns (PoolKey memory k) {
        (address a, address b) = address(coin) < address(usd) ? (address(coin), address(usd)) : (address(usd), address(coin));
        k = PoolKey(Currency.wrap(a), Currency.wrap(b), 3000, spacing, IHooks(address(0)));
    }

    function _add(PoolKey memory k, int24 lo, int24 hi, uint256 l) internal {
        liq.modifyLiquidity(k, IPoolManager.ModifyLiquidityParams(lo, hi, int256(l), bytes32(0)), "");
    }

    /// @dev A source with positions below, around and above the price, overlapping, plus one full range.
    function _richSource(int24 spacing, int24 startTick) internal returns (PoolKey memory k) {
        k = _srcKey(spacing);
        manager.initialize(k, TickMath.getSqrtPriceAtTick(startTick));
        int24 t = startTick - (startTick % spacing);
        _add(k, t - 10 * spacing, t + 10 * spacing, 1e21);
        _add(k, t - 100 * spacing, t - 20 * spacing, 5e20); // below the price: token1 only
        _add(k, t + 20 * spacing, t + 40 * spacing, 2e20); // above: token0 only
        _add(k, t - 2 * spacing, t + 30 * spacing, 3e20);
        _add(k, TickMath.minUsableTick(spacing), TickMath.maxUsableTick(spacing), 1e18);
        for (int24 i = 0; i < 8; i++) {
            _add(k, t - (50 + 3 * i) * spacing, t + (5 + 7 * i) * spacing, 1e19 * uint256(uint24(i + 1)));
        }
    }

    function _bal(PoolKey memory k) internal view returns (uint256 b0, uint256 b1) {
        b0 = MockERC20(Currency.unwrap(k.currency0)).balanceOf(address(manager));
        b1 = MockERC20(Currency.unwrap(k.currency1)).balanceOf(address(manager));
    }

    // -----------------------------------------------------------------------------------------
    // the counter itself
    // -----------------------------------------------------------------------------------------

    /// @dev Only this pool's liquidity sits in the manager, so its token balances are the pool's real TVL.
    function test_counterMatchesRealTokens() public {
        int24[3] memory sp = [int24(1), int24(60), int24(200)];
        for (uint256 j = 0; j < 3; j++) {
            manager = IPoolManager(address(new PoolManager(address(this))));
            liq = new PoolModifyLiquidityTest(manager);
            coin.approve(address(liq), type(uint256).max);
            usd.approve(address(liq), type(uint256).max);
            PoolKey memory k = _richSource(sp[j], 6931);
            (uint256 b0, uint256 b1) = _bal(k);
            WalkHarness one = new WalkHarness(sp[j]);
            one.step(manager, k.toId(), 1_000_000);
            (uint256 t0, uint256 t1, bool done) = one.totals();
            assertTrue(done, "one big call finishes");
            assertApproxEqAbs(t0, b0, 40, "token0 = real");
            assertApproxEqAbs(t1, b1, 40, "token1 = real");
            // in small steps the answer is the same
            WalkHarness small = new WalkHarness(sp[j]);
            uint256 calls;
            while (true) {
                small.step(manager, k.toId(), 4);
                calls++;
                (,, bool d) = small.totals();
                if (d) break;
            }
            (uint256 s0, uint256 s1,) = small.totals();
            assertEq(s0, t0);
            assertEq(s1, t1);
            emit log_named_uint("tick spacing", uint24(sp[j]));
            emit log_named_uint("  blocks for one pass at 4 reads per block", calls);
        }
    }

    function test_counterAtNegativePriceAndAfterSwaps() public {
        PoolKey memory k = _richSource(60, -40_000);
        swapper.swap(
            k,
            IPoolManager.SwapParams(true, -int256(1e20), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        (uint256 b0, uint256 b1) = _bal(k);
        WalkHarness h = new WalkHarness(60);
        h.step(manager, k.toId(), 1_000_000);
        (uint256 t0, uint256 t1, bool done) = h.totals();
        assertTrue(done);
        // the manager also holds the uncollected swap fee, which the counter leaves out
        assertLe(t0, b0 + 40);
        assertGe(t0, b0 * 997 / 1000);
        assertApproxEqRel(t1, b1, 1e13);
    }

    function test_emptyPoolCountsZeroAndPassesRepeat() public {
        PoolKey memory k = _srcKey(60);
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
        WalkHarness h = new WalkHarness(60);
        h.step(manager, k.toId(), 1_000_000);
        (uint256 t0, uint256 t1, bool done) = h.totals();
        assertTrue(done);
        assertEq(t0 + t1, 0);
        // liquidity added later shows up in the next pass
        _add(k, -600, 600, 1e21);
        h.step(manager, k.toId(), 1_000_000);
        (uint256 b0, uint256 b1) = _bal(k);
        (t0, t1,) = h.totals();
        assertApproxEqAbs(t0, b0, 4);
        assertApproxEqAbs(t1, b1, 4);
    }

    // -----------------------------------------------------------------------------------------
    // the hook
    // -----------------------------------------------------------------------------------------

    function _v4Source(PoolKey memory k) internal view returns (Disciple.Source memory s) {
        s.kind = 3;
        s.coinIs0 = Currency.unwrap(k.currency0) == address(coin);
        s.target = address(manager);
        s.v4Id = PoolId.unwrap(k.toId());
    }

    function _cp(Disciple.Source memory s, PoolKey memory k, uint256 c, uint256 q)
        internal
        view
        returns (Disciple.CreateParams memory)
    {
        return Disciple.CreateParams({
            coin: address(coin), quote: address(usd), fee: 3000, src: s, coinIn: c, quoteIn: q, srcKey: k, srcKey2: _noKey()
        });
    }

    function _swap(PoolKey memory key, bool buy, int256 amt) internal {
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        bool z = buy ? !coinIs0 : coinIs0;
        swapper.swap(
            key,
            IPoolManager.SwapParams(z, amt, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _next() internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
    }

    /// @dev A concentrated source: the hook's TVL is the real tokens, far below the old in-range proxy.
    function test_hookUsesRealV4Tvl() public {
        PoolKey memory k = _srcKey(60);
        bool coinIs0 = Currency.unwrap(k.currency0) == address(coin);
        int24 t = coinIs0 ? int24(6900) : int24(-6960); // ~2 USD per coin either way
        manager.initialize(k, TickMath.getSqrtPriceAtTick(t));
        _add(k, t - 60, t + 60, 1e22); // one tight range
        (uint256 b0, uint256 b1) = _bal(k); // before the Disciple seed joins the manager's balances
        (, PoolId id) = hook.createPool(_cp(_v4Source(k), k, 100e18, 200e18));
        Disciple.PoolView memory v = hook.poolState(id);
        (uint256 bc, uint256 bq) = coinIs0 ? (b0, b1) : (b1, b0);
        uint256 real = bc * v.anchorX128 / Q128 + bq;
        assertApproxEqRel(v.srcTvl, real, 1e12, "srcTvl = real tokens in USD");
        // the old proxy (2 L sqrtP, in-range liquidity as if full range) read ~66x higher here
        uint256 l = StateLibrary.getLiquidity(manager, k.toId());
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(manager, k.toId());
        uint256 proxy = coinIs0 ? 2 * l * uint256(sqrtP) / (1 << 96) : 2 * l * (1 << 96) / uint256(sqrtP);
        assertGt(proxy, 30 * v.srcTvl);
        emit log_named_uint("real TVL (USD wei)", v.srcTvl);
        emit log_named_uint("old proxy (USD wei)", proxy);
    }

    function test_gasFirstSwapWithCounter() public {
        PoolKey memory k = _richSource(60, 6931);
        (PoolKey memory key, PoolId id) = hook.createPool(_cp(_v4Source(k), k, 1000e18, 2000e18));
        assertGt(hook.poolState(id).srcTvl, 0, "first pass finished at create");
        _next();
        uint256 g = gasleft();
        _swap(key, true, -int256(10e18));
        uint256 first = g - gasleft();
        g = gasleft();
        _swap(key, false, -int256(3e18));
        uint256 second = g - gasleft();
        emit log_named_uint("v4 source: first swap in block (settle + 4 counter reads), incl. router", first);
        emit log_named_uint("v4 source: second swap same block, incl. router", second);
        emit log_named_uint("first-in-block extra", first - second);
        // the same with a v2 source (no counter) for comparison
        Pair2 pair = new Pair2(address(coin), address(usd));
        pair.set(1_000_000e18, 2_000_000e18);
        v2f.add(pair);
        Disciple.Source memory s;
        s.kind = 1;
        s.coinIs0 = true;
        s.target = address(pair);
        (PoolKey memory key2,) = hook.createPool(_cp(s, _noKey(), 1000e18, 2000e18));
        _next();
        g = gasleft();
        _swap(key2, true, -int256(10e18));
        uint256 f2 = g - gasleft();
        g = gasleft();
        _swap(key2, false, -int256(3e18));
        uint256 s2 = g - gasleft();
        emit log_named_uint("v2 source: first swap in block, incl. router", f2);
        emit log_named_uint("v2 source: first-in-block extra", f2 - s2);
        emit log_named_uint("counter cost (v4 extra - v2 extra, approx)", (first - second) - (f2 - s2));
    }

    // -----------------------------------------------------------------------------------------
    // the cross-chain sender sends real TVL
    // -----------------------------------------------------------------------------------------

    /// @dev The hook's TVL from (sqrtP, L) in token1 units: 2 L sqrtP / 2^96.
    function _tvl1(uint256 sqrtP, uint256 l) internal pure returns (uint256) {
        return 2 * Math.mulDiv(l, sqrtP, 1 << 96);
    }

    function test_senderSendsRealV4TvlOnceTracked() public {
        PoolKey memory k = _richSource(60, 6931);
        (uint256 b0, uint256 b1) = _bal(k);
        ReaderHarness r = new ReaderHarness();
        bytes32 id = PoolId.unwrap(k.toId());
        (uint256 a, uint256 bUntracked) = r.read(3, address(manager), id);
        uint256 real = Math.mulDiv(b0, a * a, 1 << 192) + b1;
        assertGt(_tvl1(a, bUntracked), 0);
        r.track(address(manager), k);
        (, uint256 b) = r.read(3, address(manager), id);
        assertApproxEqRel(_tvl1(a, b), real, 1e12, "tracked: real TVL");
        // a push keeps counting: new liquidity shows after the next pass
        _add(k, 6000, 7200, 1e21);
        (b0, b1) = _bal(k);
        real = Math.mulDiv(b0, a * a, 1 << 192) + b1;
        for (uint256 i = 0; i < 200; i++) {
            r.walk(3, address(manager), id);
        }
        (, b) = r.read(3, address(manager), id);
        assertApproxEqRel(_tvl1(a, b), real, 1e12, "refreshed");
    }

    function test_senderSendsV3Balances() public {
        uint160 p = TickMath.getSqrtPriceAtTick(6931); // ~2 token1 per token0
        V3Like v3 = new V3Like(address(coin), address(usd), p);
        coin.mint(address(v3), 1000e18);
        usd.mint(address(v3), 500e18);
        ReaderHarness r = new ReaderHarness();
        (uint256 a, uint256 b) = r.read(2, address(v3), bytes32(0));
        uint256 real = Math.mulDiv(1000e18, uint256(p) * p, 1 << 192) + 500e18;
        assertApproxEqRel(_tvl1(a, b), real, 1e12);
    }

    // -----------------------------------------------------------------------------------------
    // reversible creator cut
    // -----------------------------------------------------------------------------------------

    function _trade(PoolKey memory key) internal {
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
    }

    function test_creatorCutTurnsOffAndOnLpPayoutsStay() public {
        Pair2 pair = new Pair2(address(coin), address(usd));
        pair.set(1_000_000e18, 2_000_000e18); // TVL 4M USD
        v2f.add(pair);
        Disciple.Source memory s;
        s.kind = 1;
        s.coinIs0 = true;
        s.target = address(pair);
        (PoolKey memory key, PoolId id) = hook.createPool(_cp(s, _noKey(), 300_000e18, 600_000e18)); // 1.2M: 30%
        _next();
        _trade(key); // settles: 30% -> graduated, creator on
        assertTrue(hook.poolState(id).graduated);
        assertTrue(hook.poolState(id).creatorOn);
        _next();
        _trade(key); // pays the creator for the last block
        (uint256 cx, uint256 cy) = hook.claimCreator(id);
        assertGt(cx + cy, 0, "creator paid while on");

        // the source grows 10x: the pool is now 3% of it
        pair.set(10_000_000e18, 20_000_000e18);
        _next();
        _trade(key); // the larger TVL is seen at payout: no cut for the last block, cut off
        assertFalse(hook.poolState(id).creatorOn);
        assertTrue(hook.poolState(id).graduated, "LP payouts stay on");
        hook.claimCreator(id);
        _next();
        _trade(key);
        (cx, cy) = hook.claimCreator(id);
        assertEq(cx + cy, 0, "no creator cut while below 12%");

        // the source shrinks back: the cut returns once two readings agree (max of last and current TVL)
        pair.set(1_000_000e18, 2_000_000e18);
        _next();
        _trade(key);
        assertFalse(hook.poolState(id).creatorOn, "one low reading is not enough");
        _next();
        _trade(key);
        assertTrue(hook.poolState(id).creatorOn);
        _next();
        _trade(key);
        (cx, cy) = hook.claimCreator(id);
        assertGt(cx + cy, 0, "creator paid again");
    }
}

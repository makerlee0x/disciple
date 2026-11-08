// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";

/// @notice LAUNCH + ROUTING GATE ON THE REAL SOURCE (Robinhood fork). The offline gates use a pretend $400k v2
///         source; this one prices against what a trader can really get from Uniswap today: the live two-hop
///         STRATEGY/MSTR (hooked v4) x MSTR/USDG (v4 0.25%) route, by EXECUTING it on the fork and rolling back.
///         Skips unless FORK_RPC_RH is set. No broadcast.
///
///         test_fork_launchGate (new hook, $200 seed, 1% fee, like the planned redeploy):
///           - quoteView = swap on the fork (what routers will read is what they get)
///           - $1/$5/$20 both ways, fresh and after one $2 buy / one $2 sell: shortfall vs the real route
///             <= 100bp (our 1% fee, the source's fee counts in our favour) + 50bp ($1/$5) or 200bp ($20)
///           - $100/$500/$2000: best router split (16-point grid) after $0.02 gas: share and gain, report only
///         test_fork_canaryLivePool (after a deploy, CANARY_HOOK + CANARY_POOL set): the same quote table on the
///           live pool, read-only through quoteView, fails on the same limits. Run it before adding money.
contract LaunchGateForkTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant Q128 = 1 << 128;
    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant STRATEGY = 0x168661C52E5922288dFb2b3f323b6Cf90eb21e18;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant LEG1_HOOK = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    bytes32 internal constant LEG1 = 0xa6975f4720a95aa9cdfa9b010a065b0e941534c93f9fa708104c08f0ac029ca0;
    bytes32 internal constant LEG2 = 0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe;
    bytes32 internal constant REF_ETH_USDG = 0xa791e5169faf703c0b63fd9552c33ec1128a773a00f5dc33a640da62a022cd35;
    uint24 internal constant FEE = 10_000;
    uint256 internal constant GAS_USDG = 0.02e6; // a router's cost for one more pool on Robinhood
    uint256 internal constant LIM_FEE_BP = 100;

    DiscipleHook internal h;
    PoolKey internal key;
    PoolId internal id;
    PoolSwapTest internal sw;
    uint256 internal fails;

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("FORK_RPC_RH", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("fork gate skipped, FORK_RPC_RH unset");
            return false;
        }
        vm.createSelectFork(rpc);
        console2.log("fork block", vm.getBlockNumber());
        sw = new PoolSwapTest(PM);
        _fundAll(address(this));
        IERC20(STRATEGY).approve(address(sw), type(uint256).max);
        IERC20(USDG).approve(address(sw), type(uint256).max);
        IERC20(MSTR).approve(address(sw), type(uint256).max);
        return true;
    }

    // ---- funding (USDG packs balances, so `deal` may miss: fall back to finding the slot) ----
    function _fundAll(address who) internal {
        _give(STRATEGY, who, 1_000_000_000e18);
        _give(USDG, who, 10_000_000e6);
    }

    function _give(address token, address who, uint256 amt) internal {
        try this.dealExt(token, who, amt) {} catch {}
        if (IERC20(token).balanceOf(who) >= amt) return;
        vm.record();
        IERC20(token).balanceOf(who);
        (bytes32[] memory reads,) = vm.accesses(token);
        for (uint256 i; i < reads.length; i++) {
            bytes32 old = vm.load(token, reads[i]);
            for (uint256 sh; sh < 256; sh += 64) {
                vm.store(token, reads[i], bytes32(amt << sh));
                if (IERC20(token).balanceOf(who) == amt) return;
            }
            vm.store(token, reads[i], old);
        }
        revert("could not fund");
    }

    function dealExt(address token, address who, uint256 amt) external {
        deal(token, who, amt);
    }

    // ---- the real route: USDG <-> MSTR (leg 2) <-> STRATEGY (leg 1), executed then rolled back ----
    function _leg1Key() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(STRATEGY), Currency.wrap(MSTR), 0x800000, 8, IHooks(LEG1_HOOK));
    }

    function _leg2Key() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(USDG), Currency.wrap(MSTR), 2500, 25, IHooks(address(0)));
    }

    function _exec(PoolKey memory k, bool zeroForOne, uint256 amountIn) internal returns (uint256 out) {
        address outT = zeroForOne ? Currency.unwrap(k.currency1) : Currency.unwrap(k.currency0);
        uint256 b0 = IERC20(outT).balanceOf(address(this));
        sw.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        out = IERC20(outT).balanceOf(address(this)) - b0;
    }

    /// @dev What Uniswap's route pays for `amtIn` (USDG on a buy, STRATEGY on a sell); state is rolled back.
    function _srcOut(bool buy, uint256 amtIn) internal returns (uint256 out) {
        if (amtIn == 0) return 0;
        uint256 snap = vm.snapshotState();
        if (buy) {
            uint256 m = _exec(_leg2Key(), true, amtIn); // USDG -> MSTR
            out = _exec(_leg1Key(), false, m); // MSTR -> STRATEGY
        } else {
            uint256 m = _exec(_leg1Key(), true, amtIn); // STRATEGY -> MSTR
            out = _exec(_leg2Key(), false, m); // MSTR -> USDG
        }
        vm.revertToState(snap);
    }

    /// @dev Our quote, read-only. Coin (STRATEGY) is currency0, so a buy is oneForZero.
    function _ourOut(bool buy, uint256 amtIn) internal view returns (uint256 o) {
        if (amtIn == 0) return 0;
        (, o) = h.quoteView(id, !buy, -int256(amtIn));
    }

    /// @dev USDG raw per STRATEGY raw (X128) at the two legs' mid.
    function _spot() internal view returns (uint256) {
        (uint160 a,,,) = StateLibrary.getSlot0(PM, PoolId.wrap(LEG1));
        (uint160 b,,,) = StateLibrary.getSlot0(PM, PoolId.wrap(LEG2));
        uint256 s1 = Math.mulDiv(uint256(a) * uint256(a), Q128, uint256(1) << 192);
        uint256 raw = Math.mulDiv(uint256(b) * uint256(b), Q128, uint256(1) << 192);
        return Math.mulDiv(s1, Math.mulDiv(Q128, Q128, raw), Q128);
    }

    function _coinFor(uint256 usdg) internal view returns (uint256) {
        return Math.mulDiv(usdg, Q128, _spot());
    }

    function _shortBp(uint256 ours, uint256 src) internal pure returns (int256) {
        return (int256(src) - int256(ours)) * 10_000 / int256(src);
    }

    // ---- deploy like the runbook: new hook, $200 seed 50/50, 1% fee, two-hop source ----
    function _deploy() internal {
        DiscipleHook.Config memory cfg = DiscipleHook.Config(10_000, USDG, 3, address(PM), REF_ETH_USDG, true);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(PM, address(0), address(0), address(0), WETH, cfg);
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(DiscipleHook).creationCode, args);
        h = new DiscipleHook{salt: salt}(PM, address(0), address(0), address(0), WETH, cfg);
        IERC20(STRATEGY).approve(address(h), type(uint256).max);
        IERC20(USDG).approve(address(h), type(uint256).max);
    }

    function _create() internal {
        DiscipleHook.Source memory s;
        s.kind = 3;
        s.coinIs0 = true;
        s.target = address(PM);
        s.v4Id = LEG1;
        s.kind2 = 3;
        s.xIs0 = false;
        s.target2 = address(PM);
        s.v4Id2 = LEG2;
        (key, id) = h.createPool(
            DiscipleHook.CreateParams({
                coin: STRATEGY,
                quote: USDG,
                fee: FEE,
                src: s,
                coinIn: _coinFor(100e6) * 11 / 10, // trimmed to 50/50 at the source price
                quoteIn: 100e6,
                srcKey: _leg1Key(),
                srcKey2: _leg2Key()
            })
        );
        DiscipleHook.PoolView memory v = h.poolState(id);
        console2.log("pool reserves STRATEGY / USDG", v.coinReserve, v.quoteReserve);
    }

    function _next() internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 2);
    }

    function _swapOurs(bool buy, uint256 amtIn) internal returns (uint256) {
        return _exec(key, !buy, amtIn);
    }

    // ---- checks ----
    function _table(string memory step) internal {
        uint256[3] memory sizes = [uint256(1e6), 5e6, 20e6];
        for (uint256 i; i < 3; i++) {
            uint256 lim = LIM_FEE_BP + (i == 2 ? 200 : 50);
            int256 b = _shortBp(_ourOut(true, sizes[i]), _srcOut(true, sizes[i]));
            uint256 cIn = _coinFor(sizes[i]);
            int256 s = _shortBp(_ourOut(false, cIn), _srcOut(false, cIn));
            console2.log(
                string.concat("FORKGATE ", step, " $", vm.toString(sizes[i] / 1e6), " buy / sell shortfall bp")
            );
            console2.log("   ", vm.toString(b), vm.toString(s));
            if (b > int256(lim)) _fail(step, "buy", lim);
            if (s > int256(lim)) _fail(step, "sell", lim);
        }
    }

    function _fail(string memory step, string memory side, uint256 lim) internal {
        fails++;
        console2.log(string.concat("  FAIL ", step, " ", side, " over limit bp"), lim);
    }

    /// @dev Router-optimal split of a USDG-sized order (16-point grid), after our gas. Report only.
    function _route(string memory step) internal {
        uint256[3] memory sizes = [uint256(100e6), 500e6, 2000e6];
        for (uint256 i; i < 3; i++) {
            for (uint256 side; side < 2; side++) {
                bool buy = side == 0;
                uint256 amt = buy ? sizes[i] : _coinFor(sizes[i]);
                uint256 base = _val(buy, amt, 0);
                uint256 best = base;
                uint256 bestJ;
                for (uint256 j = 1; j <= 16; j++) {
                    uint256 v = _val(buy, amt, amt * j / 16);
                    if (v > best) (best, bestJ) = (v, j);
                }
                console2.log(
                    string.concat(
                        "FORKROUTE ",
                        step,
                        " $",
                        vm.toString(sizes[i] / 1e6),
                        buy ? " buy" : " sell",
                        " share % / gain 0.01bp"
                    ),
                    bestJ * 100 / 16,
                    (best - base) * 1_000_000 / base
                );
            }
        }
    }

    function _val(bool buy, uint256 amt, uint256 x) internal returns (uint256 v) {
        uint256 out = _ourOut(buy, x) + _srcOut(buy, amt - x);
        v = buy ? Math.mulDiv(out, _spot(), Q128) : out; // USDG
        if (x > 0) v = v > GAS_USDG ? v - GAS_USDG : 0;
    }

    function _viewMatchesSwap(bool buy, uint256 amtIn) internal {
        uint256 q = _ourOut(buy, amtIn);
        uint256 got = _swapOurs(buy, amtIn);
        assertEq(got, q, "quoteView = swap on the fork");
    }

    function test_fork_launchGate() public {
        if (!_fork()) return;
        _deploy();
        _create();
        _next();
        _table("fresh");
        _route("fresh");
        uint256 snap = vm.snapshotState();
        // first touch of a block, then the same block
        _viewMatchesSwap(true, 3e6);
        _viewMatchesSwap(false, _coinFor(2e6));
        vm.revertToState(snap);

        _swapOurs(true, 2e6);
        _next();
        h.sample(id);
        _table("after one $2 buy");
        _route("after one $2 buy");
        vm.revertToState(snap);

        _swapOurs(false, _coinFor(2e6));
        _next();
        h.sample(id);
        _table("after one $2 sell");

        console2.log("FORKGATE failures", fails);
        assertEq(fails, 0, "fork launch gate: not competitive vs the real Uniswap route (see FORKGATE log)");
    }

    /// @dev After a deploy: CANARY_HOOK=0x.. CANARY_POOL=0x.. on a fork of the chain right now. Read-only.
    function test_fork_canaryLivePool() public {
        address hk = vm.envOr("CANARY_HOOK", address(0));
        if (hk == address(0)) {
            console2.log("canary skipped, CANARY_HOOK unset");
            return;
        }
        if (!_fork()) return;
        h = DiscipleHook(payable(hk));
        id = PoolId.wrap(vm.envBytes32("CANARY_POOL"));
        DiscipleHook.PoolView memory v = h.poolState(id);
        console2.log("live reserves STRATEGY / USDG", v.coinReserve, v.quoteReserve);
        _table("live");
        _route("live");
        console2.log("CANARY failures", fails);
        assertEq(fails, 0, "canary: live pool not competitive vs the real Uniswap route (see FORKGATE log)");
    }
}

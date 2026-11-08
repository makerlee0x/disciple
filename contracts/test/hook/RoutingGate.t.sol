// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {_noKey} from "./NoKey.sol";
import {LaunchGateTest} from "./LaunchGate.t.sol";

/// @notice ROUTING + EXECUTION checks at launch size (2026-11-08, maker: "is that enough?").
///         A router splits an order between the source and us to maximise what the trader gets, minus each pool's
///         gas. This finds that best split (grid of 64 + refine) for $1..$2000 orders both ways and reports our
///         share and the gain over source-only, at Robinhood and Ethereum gas, for several of our fees.
///         Checks (fail the test): routing through us never leaves the trader worse than source-only (by
///         construction of the split, re-verified by executing it), and a $1/$5 quote taken before another
///         same-size trade in the same block still fills within 1%.
///         FINDING (2026-11-08, $200 pool vs $400k 0.3% source): routers give us ~0 share below ~$2000 at any of our
///         fees. The match cap (ask >= source ask - 1bp, bid <= source bid + 1bp) lets us beat the source's best
///         price by at most 1bp plus its impact, which our ~$0.02 gas outweighs for small orders.
///         Opt-in like the launch gate: LAUNCH_GATE=1.
contract RoutingGateTest is LaunchGateTest {
    // gas a router adds for one more pool, in USD 1e18. Our swap ~200k gas (test_gasReport, incl. router).
    // Robinhood: ~0.05 gwei x 200k x $2235/ETH = ~$0.02. Ethereum: 1 gwei x 200k x $2235 = ~$0.45.
    uint256 internal constant GAS_RH = 0.02e18;
    uint256 internal constant GAS_ETH = 0.45e18;

    /// @dev The source the pools are created against (default: the v2 0.3% mock pair, reset to $400k).
    function _source() internal virtual returns (DiscipleHook.Source memory s, PoolKey memory k) {
        pair.set(SRC_COIN, SRC_USD);
        (s, k) = (_src(0), _noKey());
    }

    function _createFee(uint24 fee) internal returns (PoolKey memory key, PoolId id) {
        (key, id) = _createSized(fee, 100e18);
    }

    function _createSized(uint24 fee, uint256 usdSide) internal returns (PoolKey memory key, PoolId id) {
        (DiscipleHook.Source memory s, PoolKey memory k) = _source();
        (key, id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: fee,
                src: s,
                coinIn: usdSide / 2,
                quoteIn: usdSide,
                srcKey: k,
                srcKey2: _noKey()
            })
        );
    }

    function _mid() internal view returns (uint256) {
        (uint256 c, uint256 u) = _srcRes();
        return u * 1e18 / c; // usd per coin, 1e18
    }

    /// @dev value to the trader (USD 1e18) of sending `x` of `amt` to us and the rest to the source, minus our gas.
    function _value(PoolKey memory key, PoolId id, bool buy, uint256 amt, uint256 x, uint256 gas)
        internal
        returns (uint256 val)
    {
        uint256 ours = x == 0 ? 0 : _ourOut(key, id, buy, x);
        uint256 src = x == amt ? 0 : _srcOut(buy, amt - x);
        uint256 out = ours + src;
        val = buy ? out * _mid() / 1e18 : out;
        if (x > 0) val = val > gas ? val - gas : 0;
    }

    /// @return share of the order we get (bp) and the trader's gain over source-only (bp of the order's value)
    function _bestSplit(PoolKey memory key, PoolId id, bool buy, uint256 usdAmt, uint256 gas)
        internal
        returns (uint256 share, int256 gainBp, uint256 bestX)
    {
        uint256 amt = buy ? usdAmt : _coinFor(usdAmt);
        uint256 base = _value(key, id, buy, amt, 0, gas);
        uint256 best = base;
        for (uint256 j = 1; j <= 64; j++) {
            uint256 x = amt * j / 64;
            uint256 val = _value(key, id, buy, amt, x, gas);
            if (val > best) (best, bestX) = (val, x);
        }
        if (bestX > 0) {
            // refine around the grid point
            uint256 step = amt / 64;
            for (uint256 r; r < 12; r++) {
                step /= 2;
                if (step == 0) break;
                uint256 lo = bestX > step ? bestX - step : 1;
                uint256 hi = bestX + step < amt ? bestX + step : amt;
                uint256 vl = _value(key, id, buy, amt, lo, gas);
                uint256 vh = _value(key, id, buy, amt, hi, gas);
                if (vl > best) (best, bestX) = (vl, lo);
                if (vh > best) (best, bestX) = (vh, hi);
            }
        }
        share = bestX * 10_000 / amt;
        gainBp = (int256(best) - int256(base)) * 1_000_000 / int256(base); // 0.01 bp
    }

    function _table(PoolKey memory key, PoolId id, string memory label, uint256 gas) internal {
        uint256[6] memory sizes = [uint256(1e18), 5e18, 20e18, 100e18, 500e18, 2000e18];
        console2.log(string.concat("ROUTE ", label));
        for (uint256 i; i < 6; i++) {
            (uint256 sb, int256 gb,) = _bestSplit(key, id, true, sizes[i], gas);
            (uint256 ss, int256 gs,) = _bestSplit(key, id, false, sizes[i], gas);
            console2.log(
                string.concat("  $", vm.toString(sizes[i] / 1e18), " buy share bp / gain 0.01bp"), sb, uint256(gb)
            );
            console2.log(
                string.concat("  $", vm.toString(sizes[i] / 1e18), " sell share bp / gain 0.01bp"), ss, uint256(gs)
            );
            assertGe(gb, 0, "routing via us never hurts the trader");
            assertGe(gs, 0, "routing via us never hurts the trader");
        }
    }

    function test_gate_routingShare() public virtual {
        if (!vm.envOr("LAUNCH_GATE", false)) return;
        vm.fee(0.01 gwei);
        uint24[3] memory fees = [uint24(3000), 5000, 10_000];
        for (uint256 f; f < 3; f++) {
            string memory fl = string.concat("fee ", vm.toString(uint256(fees[f])), " pips");
            (PoolKey memory key, PoolId id) = _createFee(fees[f]);
            _nextBlock();
            _table(key, id, string.concat(fl, ", fresh, Robinhood gas"), GAS_RH);
            _table(key, id, string.concat(fl, ", fresh, Ethereum gas"), GAS_ETH);
            _buyUsd(key, 2e18);
            _nextBlock();
            hook.sample(id);
            _table(key, id, string.concat(fl, ", after a $2 buy, Robinhood gas"), GAS_RH);
        }
    }

    /// @dev The routed split, executed: what the trader actually receives equals the quotes it was built from.
    function test_gate_routedSplitExecutes() public virtual {
        if (!vm.envOr("LAUNCH_GATE", false)) return;
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createFee(3000);
        _nextBlock();
        (,, uint256 x) = _bestSplit(key, id, true, 2000e18, GAS_RH);
        assertGt(x, 0, "a $2000 buy routes part through us at a 0.3% fee");
        uint256 q = _ourOut(key, id, true, x);
        uint256 c0 = coin.balanceOf(address(this));
        _buyUsd(key, x);
        assertEq(coin.balanceOf(address(this)) - c0, q, "executed = quoted");
    }

    /// @dev Quote, then someone else's trade lands first in the same block, then ours executes.
    function test_gate_quoteThenTradeSameBlock() public virtual {
        if (!vm.envOr("LAUNCH_GATE", false)) return;
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createGate();
        _nextBlock();
        uint256[3] memory sizes = [uint256(1e18), 5e18, 20e18];
        for (uint256 i; i < 3; i++) {
            uint256 q = _ourOut(key, id, true, sizes[i]);
            _swapAs(lp, key, true, sizes[i]); // same size, same side, lands first
            uint256 c0 = coin.balanceOf(address(this));
            _buyUsd(key, sizes[i]);
            uint256 got = coin.balanceOf(address(this)) - c0;
            uint256 slipBp = (q - got) * 10_000 / q;
            console2.log(
                string.concat("EXEC $", vm.toString(sizes[i] / 1e18), " slip after a same-size buy first, bp"), slipBp
            );
            // $1 and $5 must fill within 1%; $20 (10% of the pool, after another 10%) is reported only
            if (i < 2) assertLe(slipBp, 100, "fills within 1% of the quote after one same-block trade");
            _nextBlock();
        }
    }

    function _swapAs(address who, PoolKey memory key, bool buy, uint256 amt) internal {
        vm.startPrank(who);
        _swap(key, buy, -int256(amt));
        vm.stopPrank();
    }
}

/// @notice How big must the pool be to get routed? Same source ($400k, 0.3%), seeds $200..$50k. Report only.
contract RoutingSizeScan is RoutingGateTest {
    function test_gate_sizeScan() public {
        if (!vm.envOr("LAUNCH_GATE", false)) return;
        vm.fee(0.01 gwei);
        uint24[2] memory fees = [uint24(3000), 10_000];
        uint256[4] memory sides = [uint256(100e18), 1_000e18, 10_000e18, 25_000e18];
        uint256[3] memory sizes = [uint256(100e18), 500e18, 2000e18];
        for (uint256 f; f < 2; f++) {
            for (uint256 s; s < 4; s++) {
                (PoolKey memory key, PoolId id) = _createSized(fees[f], sides[s]);
                _nextBlock();
                for (uint256 i; i < 3; i++) {
                    (uint256 sb, int256 gb,) = _bestSplit(key, id, true, sizes[i], GAS_RH);
                    console2.log(
                        string.concat(
                            "SIZE fee ",
                            vm.toString(uint256(fees[f])),
                            " pool $",
                            vm.toString(sides[s] * 2 / 1e18),
                            " order $",
                            vm.toString(sizes[i] / 1e18),
                            " buy share bp / gain (0.01bp)"
                        ),
                        sb,
                        uint256(gb)
                    );
                }
            }
        }
    }
}

/// @notice Routing next to a 1% fee-tier source (memecoin pools usually sit there): a full-range Uniswap v4 pool
///         with fee 1% at 2 usd per coin, so the hook reads the real 1% fee for its match cap. Source $400k and
///         $50k, our pool $200 and $2k, our fee 1% and 0.5%. Report, plus the never-worse check. LAUNCH_GATE=1.
contract RoutingSource1pc is RoutingGateTest {
    using StateLibrary for IPoolManager;

    PoolModifyLiquidityTest internal liq;
    PoolKey internal srcKey;
    bool internal srcMade;
    uint256 internal srcUsd = 200_000e18; // usd side of the source; coin side is half

    function _srcFeeBp() internal view override returns (uint256) {
        return 100;
    }

    function _srcRes() internal view override returns (uint256 c, uint256 u) {
        (uint160 sp,,,) = manager.getSlot0(srcKey.toId());
        uint256 l = manager.getLiquidity(srcKey.toId());
        uint256 a = Math.mulDiv(l, Q96, sp); // token0 virtual reserve
        uint256 b = Math.mulDiv(l, sp, Q96); // token1
        (c, u) = address(coin) < address(usd) ? (a, b) : (b, a);
    }

    uint256 internal constant Q96 = 1 << 96;

    function _source() internal override returns (DiscipleHook.Source memory s, PoolKey memory k) {
        if (!srcMade) _makeSource();
        bool coinIs0 = address(coin) < address(usd);
        s.kind = 3;
        s.coinIs0 = coinIs0;
        s.target = address(manager);
        s.v4Id = PoolId.unwrap(srcKey.toId());
        k = srcKey;
    }

    function _makeSource() internal {
        srcMade = true;
        bool coinIs0 = address(coin) < address(usd);
        srcKey = PoolKey({
            currency0: Currency.wrap(coinIs0 ? address(coin) : address(usd)),
            currency1: Currency.wrap(coinIs0 ? address(usd) : address(coin)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });
        // price token1 per token0: 2 if the coin is token0, else 0.5
        uint256 pX192 = coinIs0 ? 2 << 192 : (1 << 192) / 2;
        manager.initialize(srcKey, uint160(_sqrt(pX192)));
        if (address(liq) == address(0)) {
            liq = new PoolModifyLiquidityTest(manager);
            usd.approve(address(liq), type(uint256).max);
            coin.approve(address(liq), type(uint256).max);
        }
        uint256 l = _sqrt((srcUsd / 2) * srcUsd); // coin side x usd side
        liq.modifyLiquidity(srcKey, IPoolManager.ModifyLiquidityParams(-887_200, 887_200, int256(l), bytes32(0)), "");
    }

    function _row(uint24 fee, uint256 side, string memory label) internal {
        (PoolKey memory key, PoolId id) = _createSized(fee, side);
        _nextBlock();
        uint256[6] memory sizes = [uint256(1e18), 5e18, 20e18, 100e18, 500e18, 2000e18];
        for (uint256 i; i < 6; i++) {
            (uint256 sb, int256 gb,) = _bestSplit(key, id, true, sizes[i], GAS_RH);
            (uint256 ss, int256 gs,) = _bestSplit(key, id, false, sizes[i], GAS_RH);
            console2.log(
                string.concat(
                    "SRC1 ",
                    label,
                    " order $",
                    vm.toString(sizes[i] / 1e18),
                    " buy share bp ",
                    vm.toString(sb),
                    " gain 0.01bp ",
                    vm.toString(uint256(gb))
                ),
                string.concat("sell share bp ", vm.toString(ss), " gain 0.01bp ", vm.toString(uint256(gs)))
            );
            assertGe(gb, 0, "routing via us never hurts the trader");
            assertGe(gs, 0, "routing via us never hurts the trader");
        }
    }

    function _scan(uint256 usdSide, string memory srcLabel) internal {
        srcUsd = usdSide;
        srcMade = false;
        uint24[2] memory fees = [uint24(10_000), 5000];
        uint256[2] memory sides = [uint256(100e18), 1000e18];
        for (uint256 f; f < 2; f++) {
            for (uint256 s; s < 2; s++) {
                if (!srcMade) _makeSource();
                _row(
                    fees[f],
                    sides[s],
                    string.concat(
                        srcLabel, " fee ", vm.toString(uint256(fees[f])), " pool $", vm.toString(sides[s] * 2 / 1e18)
                    )
                );
            }
        }
    }

    // the v2-source gates run in their own contracts
    function test_gate_launchSizeStaysUseful() public override {}
    function test_gate_routingShare() public override {}
    function test_gate_routedSplitExecutes() public override {}
    function test_gate_quoteThenTradeSameBlock() public override {}

    function test_gate_routing1pcSource400k() public {
        if (!vm.envOr("LAUNCH_GATE", false)) return;
        vm.fee(0.01 gwei);
        _scan(200_000e18, "src $400k 1%");
    }

    function test_gate_routing1pcSource50k() public {
        if (!vm.envOr("LAUNCH_GATE", false)) return;
        vm.fee(0.01 gwei);
        _scan(25_000e18, "src $50k 1%");
    }
}

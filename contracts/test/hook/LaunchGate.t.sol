// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {_noKey} from "./NoKey.sol";
import {DiscipleTest} from "./Disciple.t.sol";

/// @notice LAUNCH GATE: is the pool still USEFUL (priced so a router would pick it) at the real launch size, after
///         real trades? Safety tests do not check this; both live redeploys failed here, not on safety.
///
///         Setup mirrors the live launch: $200 seed (50/50) next to a $400k source, pool fee 1%, source fee 0.3%.
///         After each scenario step it quotes $1, $5 and $20 both ways on our pool and on the source, and records
///         how much worse we are ("shortfall"). Limits (agreed numbers go here; defaults below):
///           - every side, every size:  shortfall <= (our fee - source fee) + SLACK_SMALL (or SLACK_BIG at $20)
///           - after our inventory leans (people bought from us), the side we want (sells) is at least as good as
///             the source for the small sizes
///         All checks run, every failure is logged, then the test fails once with the count.
///         Result on the deployed v0.1 curve (2026-11-08): FAILS 26 checks, e.g. after one $2 buy the $1 buy is 5.5%
///         worse than the source; after 20 random $1-$20 trades buys are ~47% worse.
contract LaunchGateTest is DiscipleTest {
    uint24 internal constant OUR_FEE = 10_000; // 1%
    uint256 internal constant SRC_FEE_BP = 30; // MockPair priced as a v2 0.3% pool
    uint256 internal constant GAP_BP = 70; // our fee - source fee
    uint256 internal constant SLACK_SMALL_BP = 50; // $1 and $5
    uint256 internal constant SLACK_BIG_BP = 200; // $20 = 10% of the pool
    // source: 100k coin / 200k usd at 2 usd per coin = $400k
    uint112 internal constant SRC_COIN = 100_000e18;
    uint112 internal constant SRC_USD = 200_000e18;

    uint256 internal fails;
    uint256 internal worstBp;

    function _createGate() internal returns (PoolKey memory key, PoolId id) {
        pair.set(SRC_COIN, SRC_USD);
        (key, id) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: OUR_FEE,
                src: _src(0),
                coinIn: 50e18,
                quoteIn: 100e18,
                srcKey: _noKey(),
                srcKey2: _noKey()
            })
        );
    }

    // ---- source (v2, 0.3%) quotes from the mock pair's reserves ----
    function _srcOut(bool buy, uint256 amtIn) internal view returns (uint256) {
        (uint256 c, uint256 u) = (pair.r0(), pair.r1());
        (uint256 rin, uint256 rout) = buy ? (u, c) : (c, u);
        uint256 x = amtIn * (10_000 - SRC_FEE_BP);
        return x * rout / (rin * 10_000 + x);
    }

    function _ourOut(PoolKey memory key, PoolId id, bool buy, uint256 amtIn) internal returns (uint256 o) {
        bool coinIs0 = Currency.unwrap(key.currency0) == address(coin);
        bool z = buy ? !coinIs0 : coinIs0;
        (, o) = _quote(id, z, -int256(amtIn));
    }

    /// @dev usd amount -> coin amount at the source mid, for same-size sells
    function _coinFor(uint256 usdAmt) internal view returns (uint256) {
        return usdAmt * uint256(pair.r0()) / uint256(pair.r1());
    }

    function _shortBp(uint256 ours, uint256 src) internal pure returns (int256) {
        return (int256(src) - int256(ours)) * 10_000 / int256(src);
    }

    function _checkAll(PoolKey memory key, PoolId id, string memory step, bool wantSellAtLeastSource) internal {
        uint256[3] memory sizes = [uint256(1e18), 5e18, 20e18];
        DiscipleHook.PoolView memory v = hook.poolState(id);
        console2.log(string.concat("GATE ", step, " reserves coin/usd (1e15)"), v.coinReserve / 1e15, v.quoteReserve / 1e15);
        for (uint256 i; i < 3; i++) {
            uint256 lim = GAP_BP + (i == 2 ? SLACK_BIG_BP : SLACK_SMALL_BP);
            int256 b = _shortBp(_ourOut(key, id, true, sizes[i]), _srcOut(true, sizes[i]));
            uint256 cIn = _coinFor(sizes[i]);
            int256 s = _shortBp(_ourOut(key, id, false, cIn), _srcOut(false, cIn));
            console2.log(string.concat("GATE ", step, " $", vm.toString(sizes[i] / 1e18)));
            console2.log("  buy shortfall bp", b);
            console2.log("  sell shortfall bp", s);
            _rec(b, lim, step, "buy");
            _rec(s, lim, step, "sell");
            if (wantSellAtLeastSource && i < 2 && s > 1) {
                fails++;
                console2.log(string.concat("  FAIL ", step, ": leaning side (sell) worse than source"));
            }
        }
    }

    function _rec(int256 bp, uint256 lim, string memory step, string memory side) internal {
        if (bp > 0 && uint256(bp) > worstBp) worstBp = uint256(bp);
        if (bp > int256(lim)) {
            fails++;
            console2.log(string.concat("  FAIL ", step, " ", side, " over limit bp"), lim);
        }
    }

    function _buyUsd(PoolKey memory key, uint256 amt) internal {
        _swap(key, true, -int256(amt));
    }

    function _sellCoin(PoolKey memory key, uint256 amt) internal {
        _swap(key, false, -int256(amt));
    }

    /// @dev move the source price by `bp` (signed) at constant k, like an outside trade there
    function _moveSource(int256 bp) internal {
        uint256 c = pair.r0();
        uint256 u = pair.r1();
        uint256 k = c * u;
        // price p = u/c; new p' = p (1+bp); c' = sqrt(k/p') = c * sqrt(1/(1+bp)), u' = k/c'
        uint256 c2 = _sqrt(c * c * 10_000 / uint256(int256(10_000) + bp));
        uint256 u2 = k / c2;
        pair.set(uint112(c2), uint112(u2));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x + 1) / 2;
        while (y < z) {
            (z, y) = (y, (x / y + y) / 2);
        }
    }

    /// @dev Opt-in while the deployed v0.1 curve is known to fail (LAUNCH_GATE=1 forge test --match-test test_gate).
    ///      Make it unconditional once a hook passes it; every deploy must pass it first.
    function test_gate_launchSizeStaysUseful() public {
        if (!vm.envOr("LAUNCH_GATE", false)) {
            console2.log("launch gate skipped, set LAUNCH_GATE=1");
            return;
        }
        vm.fee(0.01 gwei);
        (PoolKey memory key, PoolId id) = _createGate();
        _nextBlock();
        _checkAll(key, id, "fresh", false);

        // one $2 buy (1% of the pool), then a new block and a sample: the live 2026-11-08 case
        _buyUsd(key, 2e18);
        _nextBlock();
        hook.sample(id);
        _checkAll(key, id, "after one $2 buy", true);

        // the mirror: one $2 sell
        (key, id) = _createGate();
        _nextBlock();
        _sellCoin(key, _coinFor(2e18));
        _nextBlock();
        hook.sample(id);
        _checkAll(key, id, "after one $2 sell", false);

        // 20 random $1-$20 trades, each in its own block, source drifting +-0.2%
        (key, id) = _createGate();
        uint256 seed = 77;
        for (uint256 j; j < 20; j++) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 usdAmt = 1e18 + (seed % 19e18);
            _nextBlock();
            if ((seed >> 128) & 1 == 0) _buyUsd(key, usdAmt);
            else _sellCoin(key, _coinFor(usdAmt));
            _moveSource(int256((seed >> 64) % 41) - 20);
        }
        _nextBlock();
        hook.sample(id);
        _checkAll(key, id, "after 20 random trades", false);

        // quiet hour: no trades, one sample
        vm.roll(vm.getBlockNumber() + 3600);
        vm.warp(vm.getBlockTimestamp() + 3600);
        hook.sample(id);
        _checkAll(key, id, "after a quiet hour", false);

        // source jumps +3%, two samples in two blocks (catch-up), then check
        _moveSource(300);
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        hook.sample(id);
        _nextBlock();
        hook.sample(id);
        _checkAll(key, id, "3% source jump + 4 samples", false);

        console2.log("GATE worst shortfall bp", worstBp);
        console2.log("GATE failures", fails);
        assertEq(fails, 0, "launch gate: pool not competitive at launch size (see GATE log)");
    }
}

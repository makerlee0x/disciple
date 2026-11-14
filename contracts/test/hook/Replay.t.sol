// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {console2} from "forge-std/Test.sol";
import {DiscipleHook} from "../../src/hook/DiscipleHook.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {_noKey} from "./NoKey.sol";

/// @notice REPLAY (offline research tool, not a unit test). Drives the real hook through a recorded leader history:
///         price rows move a v2 mock leader to the recorded mid, a keeper samples while the centre is 1%+ off, and
///         each recorded leader order is offered to a router that sends the part that beats the leader's REAL cost
///         (incl. its hidden fee) by at least RP_GAIN. Skipped unless RP_FILE is set.
///         Rows (CSV): `0,l1,t,mid1e18,0,0` price; `1,l1,t,sell,coinRaw,realFeePpm` order.
///         Prints `FILL,t,sell,coin,quote,mid` per fill and one `RESULT,...` line.
contract ReplayTest is DiscipleTest {
    PoolKey rk;
    PoolId rid;
    uint256 mid; // 1e18 = $1 per coin
    uint256 lastL1;
    uint256 lastT;
    uint256 gainMin;
    uint256 nFill;
    uint256 volUsd;
    uint256 nSample;
    uint256 nOrders;
    uint256 gainSum;
    uint256 part;
    uint256 partSalt;

    function _setMid(uint256 m) internal {
        mid = m;
        pair.set(uint112(1e27), uint112(m * 1e9)); // spot = r1 / r0 = m / 1e18
    }

    function _coinIs0() internal view returns (bool) {
        return Currency.unwrap(rk.currency0) == address(coin);
    }

    function _q(bool buy, uint256 amt) internal view returns (uint256 out) {
        bool z = buy ? !_coinIs0() : _coinIs0();
        try hook.quoteView(rid, z, -int256(amt)) returns (uint256, uint256 o) {
            out = o;
        } catch {
            out = 0;
        }
    }

    /// @dev USD (1e18) the trader gains vs the leader by sending `x` here (buy: x quote in; sell: x coin in)
    function _gain(bool buy, uint256 x, uint256 feePpm) internal view returns (int256) {
        uint256 o = _q(buy, x);
        if (o == 0) return type(int256).min;
        if (buy) {
            return int256(Math.mulDiv(o, mid, 1e18)) - int256(Math.mulDiv(x, 1e6 - feePpm, 1e6));
        }
        return int256(o) - int256(Math.mulDiv(Math.mulDiv(x, mid, 1e18), 1e6 - feePpm, 1e6));
    }

    function _keeper(uint256 toL1) internal {
        // one L1 block at a time, as the keeper does, while the centre is at least 1% off the leader
        uint256 n;
        while (lastL1 + 1 < toL1 && n < 40) {
            if (!hook.sampleDue(rid)) break;
            lastL1++;
            lastT += 12;
            vm.roll(lastL1);
            vm.warp(lastT);
            hook.sample(rid);
            nSample++;
            n++;
        }
    }

    function _order(bool sell, uint256 coinAmt, uint256 feePpm) internal {
        nOrders++;
        if (uint256(keccak256(abi.encode(nOrders, partSalt))) % 1e6 >= part) return;
        bool buy = !sell;
        uint256 full = buy ? Math.mulDiv(Math.mulDiv(coinAmt, mid, 1e18), 1e6, 1e6 - feePpm) : coinAmt;
        if (full == 0) return;
        uint256 bestX;
        int256 best;
        uint256 x = full;
        for (uint256 i; i < 14; i++) {
            int256 g = _gain(buy, x, feePpm);
            if (g > best) (best, bestX) = (g, x);
            x /= 2;
            if (x == 0) break;
        }
        // refine around the best power-of-two slice
        if (bestX != 0) {
            uint256 lo = bestX / 2;
            uint256 hi = bestX * 2 > full ? full : bestX * 2;
            for (uint256 i; i < 8; i++) {
                uint256 a = lo + (hi - lo) / 3;
                uint256 b = hi - (hi - lo) / 3;
                if (_gain(buy, a, feePpm) < _gain(buy, b, feePpm)) lo = a;
                else hi = b;
            }
            uint256 c = (lo + hi) / 2;
            int256 gc = _gain(buy, c, feePpm);
            if (gc > best) (best, bestX) = (gc, c);
        }
        if (best < int256(gainMin) || bestX == 0) return;
        (int128 dc, int128 dq) = _cqSwap(buy, bestX);
        uint256 c_ = uint256(int256(dc < 0 ? -dc : dc));
        uint256 q_ = uint256(int256(dq < 0 ? -dq : dq));
        nFill++;
        volUsd += q_;
        gainSum += uint256(best);
        console2.log(
            string.concat(
                "FILL,",
                vm.toString(lastT),
                ",",
                sell ? "1," : "0,",
                vm.toString(c_),
                ",",
                vm.toString(q_),
                ",",
                vm.toString(mid)
            )
        );
    }

    function _cqSwap(bool buy, uint256 x) internal returns (int128 dc, int128 dq) {
        bool c0 = _coinIs0();
        bool z = buy ? !c0 : c0;
        (bool ok, bytes memory r) =
            address(this).call(abi.encodeWithSelector(this.doSwap.selector, z, x));
        if (!ok) return (0, 0);
        (int128 a0, int128 a1) = abi.decode(r, (int128, int128));
        (dc, dq) = c0 ? (a0, a1) : (a1, a0);
    }

    function doSwap(bool z, uint256 x) external returns (int128, int128) {
        require(msg.sender == address(this));
        BalanceDelta d = _swap(rk, z != _coinIs0(), -int256(x));
        return (d.amount0(), d.amount1());
    }

    function _value() internal returns (uint256 v) {
        hook.withdraw(rid, 1, 0, 0); // settle
        (uint256 cx, uint256 cy) = hook.claim(rid, 1);
        (uint256 kx, uint256 ky) = hook.claimCreator(rid);
        DiscipleHook.PoolView memory pv = hook.poolState(rid);
        v = pv.quoteReserve + cy + ky + Math.mulDiv(pv.coinReserve + cx + kx, mid, 1e18);
    }

    function test_replay() public {
        string memory f = vm.envOr("RP_FILE", string(""));
        if (bytes(f).length == 0) return;
        uint24 fee = uint24(vm.envOr("RP_FEE", uint256(10_000)));
        DiscipleHook.Tune memory tn = DiscipleHook.Tune({
            edgeBps: uint16(vm.envOr("RP_EDGE", uint256(1))),
            lamPpm: uint32(vm.envOr("RP_LAM", uint256(50_000))),
            tipBps: uint16(vm.envOr("RP_TIP", uint256(12_000))),
            skimBps: uint16(vm.envOr("RP_SKIM", uint256(1200)))
        });
        uint256 seedUsd = vm.envOr("RP_USD", uint256(200e18));
        gainMin = vm.envOr("RP_GAIN", uint256(0.03e18));
        part = vm.envOr("RP_PART", uint256(1e6));
        partSalt = vm.envOr("RP_SALT", uint256(0));
        vm.fee(vm.envOr("RP_BASEFEE", uint256(0.02 gwei)));

        // first row must be a price row
        string[] memory w = vm.split(vm.readLine(f), ",");
        lastL1 = vm.parseUint(w[1]);
        lastT = vm.parseUint(w[2]);
        vm.roll(lastL1);
        vm.warp(lastT);
        _setMid(vm.parseUint(w[3]));
        uint256 m0 = mid;
        uint256 coinIn = Math.mulDiv(seedUsd / 2, 1e18, mid);
        (rk, rid) = hook.createPool(
            DiscipleHook.CreateParams({
                coin: address(coin),
                quote: address(usd),
                fee: fee,
                src: _src(0),
                coinIn: coinIn,
                quoteIn: seedUsd / 2,
                srcKey: _noKey(),
                srcKey2: _noKey(),
                tune: tn
            })
        );
        hook.fundJar(rid, 0, vm.envOr("RP_JAR", uint256(1e18)));
        DiscipleHook.PoolView memory s0 = hook.poolState(rid);
        uint256 jar0 = s0.jarY;
        uint256 holdX = s0.coinReserve;
        uint256 holdY = s0.quoteReserve;

        while (true) {
            string memory line = vm.readLine(f);
            if (bytes(line).length == 0) break;
            w = vm.split(line, ",");
            uint256 l1 = vm.parseUint(w[1]);
            uint256 t = vm.parseUint(w[2]);
            if (l1 > lastL1) {
                _keeper(l1);
                lastL1 = l1;
                lastT = t > lastT ? t : lastT + 1;
                vm.roll(lastL1);
                vm.warp(lastT);
            }
            if (bytes(w[0])[0] == "0") {
                _setMid(vm.parseUint(w[3]));
                if (hook.sampleDue(rid)) {
                    hook.sample(rid);
                    nSample++;
                }
            } else {
                _order(vm.parseUint(w[3]) == 1, vm.parseUint(w[4]), vm.parseUint(w[5]));
            }
        }
        vm.roll(lastL1 + 1);
        vm.warp(lastT + 12);
        uint256 v = _value();
        uint256 hold = holdY + Math.mulDiv(holdX, mid, 1e18);
        DiscipleHook.PoolView memory s1 = hook.poolState(rid);
        console2.log(
            string.concat(
                "RESULT,",
                vm.toString(nOrders),
                ",",
                vm.toString(nFill),
                ",",
                vm.toString(volUsd),
                ",",
                vm.toString(v),
                ",",
                vm.toString(hold),
                ",",
                vm.toString(nSample),
                ",",
                vm.toString(jar0),
                ",",
                vm.toString(s1.jarY + Math.mulDiv(s1.jarX, mid, 1e18)),
                ",",
                vm.toString(gainSum),
                ",",
                vm.toString(m0),
                ",",
                vm.toString(mid)
            )
        );
    }
}

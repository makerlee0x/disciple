// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LaunchGateForkTest} from "./LaunchGateFork.t.sol";

/// @notice GAS COMPARE (read-only fork of Robinhood now). The same PoolSwapTest swap through: this branch's hook
///         (fresh deploy, $200 two-hop pool), the live v0.2 hook (topped up on the fork), the live Carry hook
///         pools, and each leader leg alone. Prints `GAS,<what>,<gas>`. Env: FORK_RPC_RH.
contract GasCompareForkTest is LaunchGateForkTest {
    address constant V02_HOOK = 0xC0E513735F35df6A82523744E2aE8a601C772a88;
    address constant CARRY_A = 0xA52e64806d56dCd399E6204937A131f02D33aA88;
    address constant CARRY_B = 0x5800dd5c9D56C1DC9e6eB05892a6BA8e039B2A88;

    function _g(string memory what, PoolKey memory k, bool z, uint256 amt) internal returns (uint256 g) {
        uint256 g0 = gasleft();
        try this.execExt(k, z, amt) {
            g = g0 - gasleft();
            console2.log(string.concat("GAS,", what, ",", vm.toString(g)));
        } catch (bytes memory e) {
            console2.log(string.concat("GAS,", what, ",REVERT"));
            console2.logBytes(e);
        }
    }

    function execExt(PoolKey memory k, bool z, uint256 amt) external returns (uint256) {
        return _exec(k, z, amt);
    }

    function test_fork_gasCompare() public {
        if (!_fork()) return;
        _give(MSTR, address(this), 1000e18);
        IERC20(MSTR).approve(address(sw), type(uint256).max);
        uint256 two = 2e6; // $2 USDG
        uint256 coin2 = _coinFor(two);

        // leader legs alone (each its own unlock, as in one hop of a router)
        _next();
        _g("leader leg1 STRATEGY->MSTR (hook, dynamic fee)", _leg1Key(), true, coin2);
        _g("leader leg2 USDG->MSTR (no hook)", _leg2Key(), true, two);

        // v0.3, this branch
        _deploy();
        _create();
        _next();
        _g("v0.3 buy first in block", key, false, two);
        _g("v0.3 buy same block", key, false, two);
        _next();
        _g("v0.3 sell first in block", key, true, coin2);
        _g("v0.3 sell same block", key, true, coin2);
        // second round, once the pool's slots are warm (a fresh pool's first settle writes new storage)
        _next();
        _g("v0.3 buy first in block (2nd round)", key, false, two);
        _next();
        _g("v0.3 sell first in block (2nd round)", key, true, coin2);
        _next();
        uint256 g0 = gasleft();
        h.sample(id);
        console2.log(string.concat("GAS,v0.3 sample(),", vm.toString(g0 - gasleft())));

        // v0.2 live hook: its pool holds dust after the withdraw, so top it up on the fork first
        PoolKey memory k2 = PoolKey(Currency.wrap(STRATEGY), Currency.wrap(USDG), 0, 1, IHooks(V02_HOOK));
        IERC20(STRATEGY).approve(V02_HOOK, type(uint256).max);
        IERC20(USDG).approve(V02_HOOK, type(uint256).max);
        bytes32 pid = PoolId.unwrap(PoolId.wrap(keccak256(abi.encode(k2))));
        console2.logBytes32(pid);
        (bool ok,) = V02_HOOK.call(abi.encodeWithSignature("deposit(bytes32,uint256,uint256)", pid, _coinFor(100e6), 100e6));
        console2.log("v0.2 deposit ok", ok);
        _next();
        _g("v0.2 buy first in block", k2, false, two);
        _g("v0.2 buy same block", k2, false, two);
        _next();
        _g("v0.2 sell first in block", k2, true, coin2);
        _g("v0.2 sell same block", k2, true, coin2);
        _next();
        _g("v0.2 buy first in block (2nd round)", k2, false, two);
        _next();
        _g("v0.2 sell first in block (2nd round)", k2, true, coin2);

        // Carry pools (USDG/MSTR, as live; no top-up)
        uint256 m = 1e16; // 0.01 MSTR
        PoolKey memory ka = PoolKey(Currency.wrap(USDG), Currency.wrap(MSTR), 0, 1, IHooks(CARRY_A));
        PoolKey memory kb = PoolKey(Currency.wrap(USDG), Currency.wrap(MSTR), 0, 1, IHooks(CARRY_B));
        _next();
        _g("carryA buy MSTR first in block", ka, true, two);
        _g("carryA buy MSTR same block", ka, true, two);
        _next();
        _g("carryA sell MSTR first in block", ka, false, m);
        _next();
        _g("carryB buy MSTR first in block", kb, true, two);
        _g("carryB buy MSTR same block", kb, true, two);
        _next();
        _g("carryB sell MSTR first in block", kb, false, m);
    }

    /// @dev one v0.3 same-block buy and one first-in-block buy, for a -vvvv trace
    function test_fork_gasProfileV03() public {
        if (!_fork()) return;
        _deploy();
        _create();
        _next();
        _exec(key, false, 2e6);
        _next();
        _exec(key, true, _coinFor(2e6));
        console2.log("PROFILE first-in-block buy next");
        _exec(key, false, 2e6);
        console2.log("PROFILE same-block buy next");
        _exec(key, false, 2e6);
    }
}

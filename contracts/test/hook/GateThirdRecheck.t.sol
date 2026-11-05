// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Reviewer reproduction for the D-02 warm-up/bootstrap path at 2cf8cfc.
///         Passing means the unsafe creator payout was reproduced.
contract GateThirdRecheckTest is DiscipleTest {
    function test_launchDipIdleDayThenSecondDipStillPaysCreator() public {
        // First observed low: launch while source liquidity is temporarily withdrawn.
        pair.set(1000e18, 2000e18);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);

        // The real source is restored and remains high throughout the complete warm-up.
        pair.set(1_000_000e18, 2_000_000e18);
        vm.warp(block.timestamp + 1 days + 1);
        vm.roll(block.number + 1);

        // Second observed low: dip only for the first post-warm-up touch, then restore immediately.
        pair.set(1000e18, 2000e18);
        hook.withdraw(id, 1, 0, 0);
        pair.set(1_000_000e18, 2_000_000e18);

        assertTrue(hook.poolState(id).creatorOn, "two atomic lows counted as persistent low TVL");
        assertTrue(hook.poolState(id).graduated, "graduation latched from two atomic lows");

        // With source liquidity restored, fees settled later in the same block use the low gate.
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0);
        (uint256 coinClaim, uint256 quoteClaim) = hook.claimCreator(id);
        assertGt(coinClaim + quoteClaim, 0, "creator paid while source liquidity is restored");
    }

    function test_oneHighReadingDelaysGraduationAfterSourceRestored() public {
        (PoolKey memory attackedKey, PoolId attackedId) = _createSame(300_000e18, 600_000e18);
        (, PoolId controlId) = _createSame(300_000e18, 600_000e18);

        vm.warp(block.timestamp + 1 days + 1);
        vm.roll(block.number + 1);

        // A permissionless swap samples a transient 10x source-liquidity increase.
        pair.set(10_000_000e18, 20_000_000e18);
        _swap(attackedKey, true, -int256(1e18));
        pair.set(1_000_000e18, 2_000_000e18);

        // The identical control pool sees the restored source and graduates normally.
        hook.withdraw(controlId, 1, 0, 0);
        assertTrue(hook.poolState(controlId).graduated, "control graduates against actual TVL");
        assertFalse(hook.poolState(attackedId).graduated, "high sample blocks graduation");

        // Daily honest readings only get one hour of decay each. The restored source still cannot graduate
        // the attacked pool after a month.
        for (uint256 i; i < 30; ++i) {
            vm.warp(block.timestamp + 1 days);
            vm.roll(block.number + 1);
            hook.withdraw(attackedId, 1, 0, 0);
        }
        assertFalse(hook.poolState(attackedId).graduated, "one transient high reading causes prolonged denial");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Independent reviewer regressions for the creator-cut hysteresis at 364a916.
contract AuditRecheck364a916Test is DiscipleTest {
    function _next(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1);
    }

    function _normal() internal {
        pair.set(1_000_000e18, 2_000_000e18);
    }

    function _spike() internal {
        pair.set(10_000_000e18, 20_000_000e18);
    }

    function _readyBoth(PoolId a, PoolId b) internal {
        _next(1 days);
        hook.withdraw(a, 1, 0, 0);
        hook.withdraw(b, 1, 0, 0);
        _next(12);
        hook.withdraw(a, 1, 0, 0);
        hook.withdraw(b, 1, 0, 0);
        assertTrue(hook.poolState(a).creatorOn);
        assertTrue(hook.poolState(b).creatorOn);
    }

    function _fees(PoolKey memory key) internal {
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
    }

    /// The 10d7437 finding is fixed: one spike does not change the cut paid for an open fee interval.
    function test_oneSpikeDoesNotDivertCreatorCut() public {
        (PoolKey memory attackedKey, PoolId attacked) = _createSame(300_000e18, 600_000e18);
        (PoolKey memory controlKey, PoolId control) = _createSame(300_000e18, 600_000e18);
        _readyBoth(attacked, control);

        vm.warp(block.timestamp + 31);
        _fees(attackedKey);
        _fees(controlKey);

        _next(12);
        _spike();
        hook.withdraw(attacked, 1, 0, 0);
        _normal();
        hook.withdraw(control, 1, 0, 0);

        (uint256 attackedX, uint256 attackedY) = hook.claimCreator(attacked);
        (uint256 controlX, uint256 controlY) = hook.claimCreator(control);
        assertGt(attackedX + attackedY, 0);
        assertEq(attackedX + attackedY, controlX + controlY);
    }

    /// Two spikes are documented to suppress the cut for at most one day, but a quiet pool still needs two later
    /// honest readings. The first post-expiry reading settles its open fees while the cut remains off.
    function test_twoSpikesStillDivertAfterMemoryExpired() public {
        (PoolKey memory attackedKey, PoolId attacked) = _createSame(300_000e18, 600_000e18);
        (PoolKey memory controlKey, PoolId control) = _createSame(300_000e18, 600_000e18);
        _readyBoth(attacked, control);

        _next(12);
        _spike();
        hook.withdraw(attacked, 1, 0, 0); // first spike: hysteresis keeps the cut on
        _normal();
        assertTrue(hook.poolState(attacked).creatorOn);

        _next(12);
        _spike();
        hook.withdraw(attacked, 1, 0, 0); // second spike: turns it off
        _normal();
        assertFalse(hook.poolState(attacked).creatorOn);

        // Real-time memory fully expires while the source remains normal and the pool is quiet.
        _next(1 days + 1);
        // The first swap is the first honest observation. It is still paired with the last spike, so fees earned
        // after the one-day bound can be settled later in this block while the creator cut remains off.
        _fees(attackedKey);
        _fees(controlKey);
        assertFalse(hook.poolState(attacked).creatorOn, "cut remains off after the one-day bound");
        hook.withdraw(attacked, 1, 0, 0);
        hook.withdraw(control, 1, 0, 0);

        (uint256 attackedX, uint256 attackedY) = hook.claimCreator(attacked);
        (uint256 controlX, uint256 controlY) = hook.claimCreator(control);
        assertEq(attackedX + attackedY, 0, "expired spikes still divert the cut");
        assertGt(controlX + controlY, 0, "honest control pays the creator");

        _next(12);
        hook.withdraw(attacked, 1, 0, 0);
        assertTrue(hook.poolState(attacked).creatorOn, "second honest reading finally restores the cut");
    }

    /// After the initial pair turns the cut off, one spike every other observation prevents two honest readings
    /// from ever becoming adjacent. The one-day memory no longer bounds the denial.
    function test_alternatingSpikesKeepCutOffIndefinitely() public {
        (PoolKey memory attackedKey, PoolId attacked) = _createSame(300_000e18, 600_000e18);
        (PoolKey memory controlKey, PoolId control) = _createSame(300_000e18, 600_000e18);
        _readyBoth(attacked, control);

        for (uint256 i = 0; i < 2; i++) {
            _next(12);
            _spike();
            hook.withdraw(attacked, 1, 0, 0);
            _normal();
        }
        assertFalse(hook.poolState(attacked).creatorOn);

        // Three honest/spike pairs over six days. The attacker controls only every second observation.
        for (uint256 i = 0; i < 3; i++) {
            _next(1 days);
            hook.withdraw(attacked, 1, 0, 0);
            assertFalse(hook.poolState(attacked).creatorOn);
            _next(1 days);
            _spike();
            hook.withdraw(attacked, 1, 0, 0);
            _normal();
            assertFalse(hook.poolState(attacked).creatorOn);
        }

        // An honest first touch is still paired with the last spike. Fees earned and settled later in this block
        // pay no creator cut, while the identical control does.
        _next(1 days);
        _fees(attackedKey);
        _fees(controlKey);
        assertFalse(hook.poolState(attacked).creatorOn);
        hook.withdraw(attacked, 1, 0, 0);
        hook.withdraw(control, 1, 0, 0);
        (uint256 attackedX, uint256 attackedY) = hook.claimCreator(attacked);
        (uint256 controlX, uint256 controlY) = hook.claimCreator(control);
        assertEq(attackedX + attackedY, 0);
        assertGt(controlX + controlY, 0);
    }
}

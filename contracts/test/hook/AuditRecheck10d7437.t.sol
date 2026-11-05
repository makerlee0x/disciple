// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiscipleTest} from "./Disciple.t.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Independent reviewer regressions for the two D-02 failures found at 2cf8cfc.
contract AuditRecheck10d7437Test is DiscipleTest {
    function _next(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1);
    }

    function _high() internal {
        pair.set(1_000_000e18, 2_000_000e18);
    }

    function _low() internal {
        pair.set(1000e18, 2000e18);
    }

    /// The launch observation and the first later observation cannot form the required pair.
    function test_launchDipAndFirstPostWarmupDipDoNotEnableCreator() public {
        _low();
        (, PoolId id) = _createSame(1000e18, 2000e18);
        _high();

        _next(1 days + 1);
        _low();
        hook.withdraw(id, 1, 0, 0);
        _high();

        assertFalse(hook.poolState(id).creatorOn);
        assertFalse(hook.poolState(id).graduated);

        // Two later honest observations establish the real source TVL.
        _next(12);
        hook.withdraw(id, 1, 0, 0);
        _next(12);
        hook.withdraw(id, 1, 0, 0);
        assertFalse(hook.poolState(id).creatorOn);
        assertFalse(hook.poolState(id).graduated);
    }

    /// One transient high observation is discarded after two later honest observations.
    function test_oneSpikeCannotDelayGraduationPastTwoReadings() public {
        (PoolKey memory key, PoolId id) = _createSame(300_000e18, 600_000e18);

        _next(1 days);
        hook.withdraw(id, 1, 0, 0);

        _next(12);
        pair.set(10_000_000e18, 20_000_000e18);
        _swap(key, true, -int256(1e18));
        _high();
        assertFalse(hook.poolState(id).graduated);

        _next(12);
        hook.withdraw(id, 1, 0, 0);
        assertFalse(hook.poolState(id).graduated);

        _next(12);
        hook.withdraw(id, 1, 0, 0);
        assertTrue(hook.poolState(id).graduated);
    }

    /// The brief says one spike does nothing to the creator cut, but the last-two maximum is also used for that cut.
    function test_oneSpikeDivertsTheCreatorCutToLps() public {
        (PoolKey memory attackedKey, PoolId attacked) = _createSame(300_000e18, 600_000e18);
        (PoolKey memory controlKey, PoolId control) = _createSame(300_000e18, 600_000e18);

        _next(1 days);
        hook.withdraw(attacked, 1, 0, 0);
        hook.withdraw(control, 1, 0, 0);
        _next(12);
        hook.withdraw(attacked, 1, 0, 0);
        hook.withdraw(control, 1, 0, 0);
        assertTrue(hook.poolState(attacked).creatorOn);
        assertTrue(hook.poolState(control).creatorOn);

        vm.warp(block.timestamp + 31);
        _swap(attackedKey, true, -int256(50e18));
        _swap(attackedKey, false, -int256(20e18));
        _swap(controlKey, true, -int256(50e18));
        _swap(controlKey, false, -int256(20e18));

        _next(12);
        pair.set(10_000_000e18, 20_000_000e18);
        hook.withdraw(attacked, 1, 0, 0);
        _high();
        hook.withdraw(control, 1, 0, 0);

        (uint256 attackedX, uint256 attackedY) = hook.claimCreator(attacked);
        (uint256 controlX, uint256 controlY) = hook.claimCreator(control);
        assertEq(attackedX + attackedY, 0, "one spike removed the creator cut");
        assertGt(controlX + controlY, 0, "the honest control paid the creator");
    }
}

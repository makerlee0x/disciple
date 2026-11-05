// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {DiscipleTest} from "./Disciple.t.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

contract GateRecheckTest is DiscipleTest {
    function test_idleThenAtomicDipStillPays() public {
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        // The source remains fully funded throughout three idle days.
        vm.warp(block.timestamp + 3 days);
        _nextBlock();
        pair.set(1000e18, 2000e18);
        hook.withdraw(id, 1, 0, 0);
        pair.set(1_000_000e18, 2_000_000e18);
        assertTrue(hook.poolState(id).creatorOn, "one low read used all idle-time decay");
        // Graduation is now latched; settle this block's trades before another source reading.
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0);
        (uint256 x, uint256 y) = hook.claimCreator(id);
        assertGt(x + y, 0, "creator paid with source restored");
        emit log_named_uint("creator coin", x);
        emit log_named_uint("creator quote", y);
    }
    function test_creationDuringAtomicDipBootstrapsLowGate() public {
        pair.set(1000e18, 2000e18);
        (PoolKey memory key, PoolId id) = _createSame(1000e18, 2000e18);
        pair.set(1_000_000e18, 2_000_000e18);
        vm.warp(block.timestamp + 31);
        _swap(key, true, -int256(50e18));
        hook.withdraw(id, 1, 0, 0);
        assertTrue(hook.poolState(id).graduated, "low initial gate latches graduation");
        _swap(key, false, -int256(20e18));
        hook.withdraw(id, 1, 0, 0);
        (uint256 x, uint256 y) = hook.claimCreator(id);
        assertGt(x + y, 0, "creator paid before a new block samples restored TVL");
    }
}

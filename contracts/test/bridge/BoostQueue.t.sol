// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoostQueue} from "../../src/bridge/libraries/BoostQueue.sol";

/// @dev Holds one queue in storage and mirrors it with a brute-force array.
contract BoostQueueHarness {
    using BoostQueue for BoostQueue.Queue;

    BoostQueue.Queue internal q;
    uint256[] internal mirror; // mirror[id - 1] = live amount

    function push(uint256 amt) external returns (uint256 id) {
        id = q.push(amt);
        mirror.push(amt);
    }

    function increase(uint256 id, uint256 amt) external {
        q.increase(id, amt);
        mirror[id - 1] += amt;
    }

    function decrease(uint256 id, uint256 amt) external {
        q.decrease(id, amt);
        mirror[id - 1] -= amt;
    }

    function ahead(uint256 id) external view returns (uint256) {
        return q.ahead(id);
    }

    function bruteAhead(uint256 id) external view returns (uint256 s) {
        for (uint256 i = 0; i + 1 < id; i++) {
            s += mirror[i];
        }
    }

    function count() external view returns (uint256) {
        return q.count;
    }

    function total() external view returns (uint256) {
        return q.total;
    }

    function amountOf(uint256 id) external view returns (uint256) {
        return q.amount[id];
    }

    function mirrorTotal() external view returns (uint256 s) {
        for (uint256 i = 0; i < mirror.length; i++) {
            s += mirror[i];
        }
    }
}

contract BoostQueueTest is Test {
    BoostQueueHarness internal h;

    function setUp() public {
        h = new BoostQueueHarness();
    }

    // ---- queue ----------------------------------------------------------------------------

    function test_aheadIsSumOfEarlierPositions() public {
        h.push(100);
        h.push(50);
        h.push(25);
        assertEq(h.ahead(1), 0);
        assertEq(h.ahead(2), 100);
        assertEq(h.ahead(3), 150);
        assertEq(h.total(), 175);
    }

    function test_leaverMovesEveryoneBehindUp() public {
        for (uint256 i = 0; i < 10; i++) {
            h.push(10);
        }
        h.decrease(3, 10); // position 3 leaves
        assertEq(h.ahead(2), 10, "ahead of the leaver is unchanged");
        assertEq(h.ahead(4), 20, "position 4 moved up by 10");
        assertEq(h.ahead(10), 80);
    }

    function test_partialWithdrawalKeepsPlace() public {
        h.push(100);
        h.push(100);
        h.decrease(1, 60);
        assertEq(h.amountOf(1), 40);
        assertEq(h.ahead(2), 40);
    }

    function test_pushAfterLeaversCountsOnlyLiveAmounts() public {
        h.push(100);
        h.push(100);
        h.decrease(1, 100);
        uint256 id = h.push(5);
        assertEq(h.ahead(id), 100);
    }

    function test_unknownPositionReverts() public {
        vm.expectRevert(BoostQueue.UnknownPosition.selector);
        h.ahead(1);
        h.push(1);
        vm.expectRevert(BoostQueue.UnknownPosition.selector);
        h.decrease(2, 1);
        vm.expectRevert(BoostQueue.UnknownPosition.selector);
        h.increase(0, 1);
    }

    function test_cannotWithdrawMoreThanPosition() public {
        h.push(10);
        vm.expectRevert(BoostQueue.AmountTooLarge.selector);
        h.decrease(1, 11);
    }

    /// Random pushes, partial and full withdrawals and top-ups, checked against the brute-force sum
    /// for every position after every step.
    function testFuzz_matchesBruteForce(uint256 seed) public {
        for (uint256 step = 0; step < 48; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 n = h.count();
            uint256 kind = seed % 10;
            if (n == 0 || kind < 5) {
                h.push((seed >> 8) % 1e24);
            } else if (kind < 8) {
                uint256 id = 1 + ((seed >> 16) % n);
                uint256 cur = h.amountOf(id);
                h.decrease(id, cur == 0 ? 0 : (seed >> 32) % (cur + 1));
            } else {
                uint256 id = 1 + ((seed >> 16) % n);
                h.increase(id, (seed >> 32) % 1e20);
            }
            n = h.count();
            for (uint256 id = 1; id <= n; id++) {
                assertEq(h.ahead(id), h.bruteAhead(id), "prefix mismatch");
            }
            assertEq(h.total(), h.mirrorTotal(), "total mismatch");
        }
    }

    function test_withdrawCostStaysFlatWithManyPositions() public {
        for (uint256 i = 0; i < 2000; i++) {
            h.push(1);
        }
        uint256 g = gasleft();
        h.decrease(1, 1); // the worst case: the front position walks up the tree
        uint256 used = g - gasleft();
        // 2000 positions -> at most 11 tree nodes written. A loop over everyone behind would be ~2000.
        assertLt(used, 400_000);
        assertEq(h.ahead(2000), 1998);
    }

    // ---- boost schedule ------------------------------------------------------------------

    function test_boostFrontTailAndMiddle() public pure {
        uint256 r = 1_000e18;
        assertApproxEqAbs(BoostQueue.boostBps(0, 1, r), 70_000, 1, "a tiny front position gets 7x (less a rounding unit)");
        assertEq(BoostQueue.boostBps(r, 1e18, r), 12_000, "at the end of the range: 1.2x");
        assertEq(BoostQueue.boostBps(5 * r, 1e18, r), 12_000, "past the range: 1.2x");
        assertEq(BoostQueue.boostBps(r / 2, 0, r), 41_000, "halfway point: 4.1x");
        assertEq(BoostQueue.boostBps(0, r, r), 41_000, "spanning the whole slide averages 4.1x");
        assertEq(BoostQueue.boostBps(0, 2 * r, r), 26_500, "half slide, half tail");
        assertEq(BoostQueue.boostBps(0, 1e18, 0), 12_000, "no range yet: 1.2x");
    }

    function testFuzz_boostWithinBounds(uint128 aheadAmt, uint128 size, uint128 range) public pure {
        uint256 b = BoostQueue.boostBps(aheadAmt, size, range);
        assertGe(b, 12_000);
        assertLe(b, 70_000);
    }

    function testFuzz_splittingDoesNotChangeWeight(uint96 aheadAmt, uint96 a, uint96 b, uint96 range) public pure {
        uint256 whole = BoostQueue.weight(aheadAmt, uint256(a) + b, range);
        uint256 split = BoostQueue.weight(aheadAmt, a, range) + BoostQueue.weight(uint256(aheadAmt) + a, b, range);
        // Same shares in the same place in line carry exactly the same weight: weights are differences of one
        // rounded prefix potential, so they telescope. Splitting a position into wallets gains nothing.
        assertEq(split, whole);
    }

    function testFuzz_weightsSumToPotential(uint96 a, uint96 b, uint96 c, uint96 range) public pure {
        uint256 total = uint256(a) + b + c;
        uint256 sum = BoostQueue.weight(0, a, range) + BoostQueue.weight(a, b, range)
            + BoostQueue.weight(uint256(a) + b, c, range);
        assertEq(sum, BoostQueue.potential(total, range), "position weights sum to F(total), the denominator");
    }

    function test_weightIsBoostTimesSize() public pure {
        uint256 r = 1_000e18;
        assertEq(BoostQueue.weight(0, r, r), 41_000 * r);
        assertEq(BoostQueue.weight(r, 7e18, r), 12_000 * 7e18);
        assertEq(BoostQueue.weight(0, 0, r), 0);
    }
}

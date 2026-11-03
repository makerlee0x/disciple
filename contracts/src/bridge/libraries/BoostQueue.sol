// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Disciple's FIFO LP boost queue
/// @notice LP positions form one first-in-first-out line per pool, ordered by deposit. A position's
///         boost depends on how much sits ahead of it: 7x at the front, sliding linearly to 1.2x at
///         `range` (7% of the source pool's live TVL), and 1.2x after that. When a position ahead
///         shrinks or leaves, everyone behind moves up without being written to.
///
///         The line is a Fenwick (binary indexed) tree over each position's amount (LP shares), so
///         "amount ahead of position i" is a prefix sum. Positions are append-only, which allows the
///         lazy variant: a new node is initialised from the prefix sums at append time, and an update
///         only walks up to the current count. Every operation costs O(log n) storage reads or writes,
///         however many positions exist, so dust positions cannot push a withdrawal past the gas limit.
library BoostQueue {
    /// @dev 7x, 1.2x and their difference, in basis points of 1x.
    uint256 internal constant FRONT_BPS = 70_000;
    uint256 internal constant TAIL_BPS = 12_000;
    uint256 internal constant SLIDE_BPS = FRONT_BPS - TAIL_BPS;

    struct Queue {
        uint256 count; // positions ever appended; ids are 1..count
        uint256 total; // sum of all live amounts
        mapping(uint256 id => uint256) amount; // each position's live amount
        mapping(uint256 node => uint256) tree; // Fenwick nodes: tree[i] = sum of amount over (i - lowbit(i), i]
    }

    error UnknownPosition();
    error AmountTooLarge();

    /// @notice Append a position at the back of the line.
    function push(Queue storage q, uint256 amt) internal returns (uint256 id) {
        id = q.count + 1;
        // tree[id] covers (id - lowbit(id), id]: the new amount plus the live amounts already in that span.
        q.tree[id] = amt + _prefix(q, id - 1) - _prefix(q, id - _lowbit(id));
        q.count = id;
        q.amount[id] = amt;
        q.total += amt;
    }

    /// @notice Add to an existing position, keeping its place. (A top-up is normally a new `push`.)
    function increase(Queue storage q, uint256 id, uint256 amt) internal {
        if (id == 0 || id > q.count) revert UnknownPosition();
        q.amount[id] += amt;
        q.total += amt;
        uint256 n = q.count;
        for (uint256 i = id; i <= n; i += _lowbit(i)) {
            q.tree[i] += amt;
        }
    }

    /// @notice Remove part or all of a position. A partial withdrawal keeps the place in line.
    function decrease(Queue storage q, uint256 id, uint256 amt) internal {
        if (id == 0 || id > q.count) revert UnknownPosition();
        uint256 cur = q.amount[id];
        if (amt > cur) revert AmountTooLarge();
        q.amount[id] = cur - amt;
        q.total -= amt;
        uint256 n = q.count;
        for (uint256 i = id; i <= n; i += _lowbit(i)) {
            q.tree[i] -= amt;
        }
    }

    /// @notice Live amount in front of position `id`.
    function ahead(Queue storage q, uint256 id) internal view returns (uint256) {
        if (id == 0 || id > q.count) revert UnknownPosition();
        return _prefix(q, id - 1);
    }

    /// @notice A position's boost weight: the 7x -> 1.2x schedule integrated over the span
    ///         [aheadAmt, aheadAmt + size) of the line, in bps x amount. Fee accounting uses this
    ///         directly, so there is no per-position averaging loss. `range` is where the slide
    ///         reaches 1.2x. All three are in the same unit (shares or dollars).
    function weight(uint256 aheadAmt, uint256 size, uint256 range) internal pure returns (uint256) {
        if (size == 0) return 0;
        if (range == 0 || aheadAmt >= range) return TAIL_BPS * size;
        uint256 end = aheadAmt + size;
        uint256 x1 = end < range ? end : range;
        uint256 w = x1 - aheadAmt; // part of the span on the slide
        // Integral of (FRONT - SLIDE * x / range) over [aheadAmt, x1]
        //   = FRONT * w - SLIDE * w * (aheadAmt + x1) / (2 * range).
        // aheadAmt + x1 <= 2 * range, so the subtraction never underflows.
        uint256 slide = FRONT_BPS * w - (SLIDE_BPS * w * (aheadAmt + x1)) / (2 * range);
        return slide + (end > range ? TAIL_BPS * (end - range) : 0);
    }

    /// @notice The average boost of a span in bps of 1x (for display). A zero-size span reports the
    ///         marginal boost at its position.
    function boostBps(uint256 aheadAmt, uint256 size, uint256 range) internal pure returns (uint256) {
        if (size == 0) {
            if (range == 0 || aheadAmt >= range) return TAIL_BPS;
            return FRONT_BPS - (SLIDE_BPS * aheadAmt) / range;
        }
        return weight(aheadAmt, size, range) / size;
    }

    function _prefix(Queue storage q, uint256 i) private view returns (uint256 s) {
        while (i > 0) {
            s += q.tree[i];
            i -= _lowbit(i);
        }
    }

    function _lowbit(uint256 i) private pure returns (uint256) {
        unchecked {
            return i & (0 - i);
        }
    }
}

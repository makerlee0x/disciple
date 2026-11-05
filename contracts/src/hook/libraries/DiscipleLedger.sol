// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Disciple LP ledger
/// @notice LP accounting for one Disciple pool: shares, the whole-line boost, the compound class, graduation, the
///         creator cut, in-kind payouts and the pool-wide loss carry. The hook owns tokens and permissions; this
///         library only keeps the books. Line-for-line copy of sim/accounting/intledger.py, which is checked against
///         the exact rational model (fast.py, ledger2.py) by compare_int.py. Keep them in step.
///
///         Decided design (maker, 2026-11-03/04):
///         - Earnings are marked at the anchor: e = dy + M * dx over each settlement interval, minus nothing else
///           (keeper refunds come from the separate ETH tank). Losses carry forward pool-wide.
///         - Settle every block and before any deposit, withdrawal or restake. The hook passes `distribute = false`
///           while a cross-chain pool is in local mode: results then stay in share value pro rata.
///         - Below graduation everything compounds. Graduation latches once pool value >= 12% of the source TVL;
///           after it LPs are paid in kind into escrow. The creator takes 12% (paid out, or compounded if they
///           choose) of an interval only if the pool is at or above that 12% when the interval is settled.
///         - Boost: principal lots form one FIFO line, weighted 7x at the front sliding linearly to 1.2x at the back
///           (F(z) = 7z - 2.9 z^2 / S). Compounded earnings are a separate class weighted a flat 1.2x. `restake`
///           turns a lot's compounded balance into a new principal lot at the back.
///
///         Exact O(log n) form: per set k (sh = compound units, cx / cy = coin / quote claims) the pool keeps
///         A1 = sum q and A2 = sum q / Sp, and Fenwick prefix sums of c_j and s_j with X_j = c_j + s_j * A2. A lot's
///         reward is 7 s dA1 - 2.9 s^2 dA2 - 5.8 s dPX. Swaps cost O(1); capital changes cost O(log n).
///
///         Scales: amounts and shares in token wei; mark M in X128; q, A1, I, T in RAY; A2 in RAY * 1e18 per share.
///         Every rounding goes against the LP.
library DiscipleLedger {
    uint256 internal constant RAY = 1e27;
    uint256 internal constant K2 = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant TARGET_BPS = 1200;
    uint256 internal constant CREATOR_BPS = 1200;
    /// @dev Shares that can never be withdrawn, so the pool never drains to rounding dust.
    uint256 internal constant MIN_SHARES = 1e6;

    uint8 internal constant SH = 0;
    uint8 internal constant CX = 1;
    uint8 internal constant CY = 2;

    error UnknownLot();
    error NotOwner();
    error TooMuch();
    error WouldDrain();
    error ZeroShares();

    struct Lot {
        address owner;
        uint256 s; // principal shares
        uint256 n; // compound units; balance b = n * I / RAY
        uint256 claimX;
        uint256 claimY;
        uint256[3] snapA1;
        uint256[3] snapA2;
        int256[3] snapPX;
        uint256 snapTx;
        uint256 snapTy;
    }

    struct Book {
        uint256 x; // tradable coin reserve
        uint256 y; // tradable quote reserve
        int256 dx; // net coin into the pool since the last settlement
        int256 dy;
        uint256 lossCarry;
        bool graduated;
        bool creatorCompounds;
        bool creatorOn; // the creator's cut applies (pool >= 12% of the source at the last settlement)
        address creator;
        uint256 sp; // total principal shares
        uint256 b; // total compound balance (share units)
        uint256 index; // I, RAY
        uint256[3] a1;
        uint256[3] a2;
        uint256 compX; // compound-class coin claim per share unit, RAY
        uint256 compY;
        uint256 escrowX;
        uint256 escrowY;
        uint256 creatorClaimX;
        uint256 creatorClaimY;
        uint256 creatorLot;
        uint256 count;
        mapping(uint256 => Lot) lots;
        mapping(uint256 => int256) fs;
        mapping(uint256 => int256) fc0;
        mapping(uint256 => int256) fc1;
        mapping(uint256 => int256) fc2;
    }

    // ---------------------------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------------------------

    /// @notice Seed the pool. The creator's lot takes shares equal to the seed's value at mark M (quote wei).
    function init(Book storage bk, address creator, uint256 x, uint256 y, uint256 markX128) internal returns (uint256 id) {
        bk.x = x;
        bk.y = y;
        bk.creator = creator;
        bk.index = RAY;
        id = _newLot(bk, creator);
        uint256 v = value(bk, markX128);
        if (v <= MIN_SHARES) revert ZeroShares();
        _resize(bk, id, v);
    }

    function value(Book storage bk, uint256 markX128) internal view returns (uint256) {
        return Math.mulDiv(bk.x, markX128, Q128) + bk.y;
    }

    // ---------------------------------------------------------------------------------------------
    // Trading and settlement
    // ---------------------------------------------------------------------------------------------

    /// @notice Record a fill: the pool received `dx` coin and `dy` quote (negative = paid out). O(1).
    function swap(Book storage bk, int256 dx, int256 dy) internal {
        bk.x = _addSigned(bk.x, dx);
        bk.y = _addSigned(bk.y, dy);
        bk.dx += dx;
        bk.dy += dy;
    }

    /// @notice Close the interval: mark its flow at `markX128`, apply the loss carry, distribute, latch graduation.
    ///         `creatorTvl` / `gradTvl` are the source TVL (quote wei) the creator cut and graduation are judged
    ///         against (the hook passes creatorTvl >= gradTvl; 0 = not judged). Returns the distributable amount Q.
    function settle(Book storage bk, uint256 markX128, uint256 creatorTvl, uint256 gradTvl, bool distribute)
        internal
        returns (uint256 q)
    {
        int256 dx = bk.dx;
        int256 e = bk.dy
            + (
                dx >= 0
                    ? int256(Math.mulDiv(uint256(dx), markX128, Q128))
                    : -int256(Math.mulDiv(uint256(-dx), markX128, Q128, Math.Rounding.Ceil))
            );
        bk.dx = 0;
        bk.dy = 0;
        if (!distribute) return 0;
        uint256 l = bk.lossCarry;
        if (e >= int256(l)) {
            q = uint256(e) - l;
            bk.lossCarry = 0;
        } else {
            bk.lossCarry = uint256(int256(l) - e);
        }
        uint256 v = value(bk, markX128);
        // The creator cut is judged NOW, before paying this interval (review D-02): a source that has recovered
        // since the last settlement gets no cut. A zero TVL means "not known yet" and leaves it as it is.
        bool on = bk.creatorOn;
        if (creatorTvl > 0) {
            on = v * BPS >= TARGET_BPS * creatorTvl;
            bk.creatorOn = on;
        }
        bool grad = on || (gradTvl > 0 && v * BPS >= TARGET_BPS * gradTvl);
        // Spec: nothing is distributed if Q >= V. Q > V/2 is also held back (it stays in share value pro rata) so
        // the 1/(V - D) terms stay bounded.
        if (q > 0 && 2 * q <= v) _distribute(bk, q, v);
        // LP payouts latch at the first crossing (from the next interval), which keeps the boost accounting exact.
        // The creator's cut is reversible (maker, 2026-11-04), checked above.
        if (grad) bk.graduated = true;
    }

    function _distribute(Book storage bk, uint256 d, uint256 v) private {
        uint256 st = bk.sp + bk.b;
        uint256 w10 = 41 * bk.sp + 12 * bk.b;
        if (w10 == 0) return;
        if (!bk.graduated) {
            uint256 lp = d;
            bk.index += Math.mulDiv(bk.index, 12 * lp * st, w10 * (v - d));
            uint256 q = Math.mulDiv(Math.mulDiv(10 * lp * st, RAY, w10 * (v - d)), RAY, bk.index);
            _accrue(bk, SH, q);
            bk.b += Math.mulDiv(lp, st, v - d, Math.Rounding.Ceil);
            return;
        }
        uint256 cd = bk.creatorOn ? Math.mulDiv(d, CREATOR_BPS, BPS, Math.Rounding.Ceil) : 0;
        uint256 lpAmt = d - cd;
        uint256 x0 = bk.x;
        uint256 y0 = bk.y;
        _accrue(bk, CX, Math.mulDiv(10 * lpAmt * x0, RAY, w10 * v));
        _accrue(bk, CY, Math.mulDiv(10 * lpAmt * y0, RAY, w10 * v));
        bk.compX += Math.mulDiv(12 * lpAmt * x0, RAY, w10 * v);
        bk.compY += Math.mulDiv(12 * lpAmt * y0, RAY, w10 * v);
        uint256 ex = Math.mulDiv(x0, lpAmt, v, Math.Rounding.Ceil);
        uint256 ey = Math.mulDiv(y0, lpAmt, v, Math.Rounding.Ceil);
        bk.x -= ex;
        bk.y -= ey;
        bk.escrowX += ex;
        bk.escrowY += ey;
        if (cd == 0) return;
        if (bk.creatorCompounds) {
            if (bk.creatorLot == 0) bk.creatorLot = _newLot(bk, bk.creator);
            uint256 cl = bk.creatorLot;
            _checkpoint(bk, cl);
            uint256 add = Math.mulDiv(cd, st, v - d);
            bk.lots[cl].n += Math.mulDiv(add, RAY, bk.index);
            bk.b += add;
        } else {
            uint256 cx = Math.mulDiv(x0, cd, v);
            uint256 cy = Math.mulDiv(y0, cd, v);
            bk.creatorClaimX += cx;
            bk.creatorClaimY += cy;
            bk.x -= cx;
            bk.y -= cy;
        }
    }

    function _accrue(Book storage bk, uint8 k, uint256 q) private {
        bk.a1[k] += q;
        // The slide's quadratic term always applies while there is principal; skipping it would pay every share
        // the 7x front weight and distribute more than was earned.
        if (bk.sp > 0) bk.a2[k] += Math.mulDiv(q, K2, bk.sp, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------------------------------------
    // Capital changes. The hook settles first (same block) and moves the tokens.
    // ---------------------------------------------------------------------------------------------

    /// @notice New principal lot at the back of the line, at the current reserve ratio. Returns the lot id, the
    ///         shares, and the tokens actually taken (the rest of dx/dy is the depositor's to keep).
    function deposit(Book storage bk, address owner, uint256 dx, uint256 dy)
        internal
        returns (uint256 id, uint256 shares, uint256 takeX, uint256 takeY)
    {
        uint256 st = bk.sp + bk.b;
        shares = Math.min(Math.mulDiv(dx, st, bk.x), Math.mulDiv(dy, st, bk.y));
        if (shares == 0) revert ZeroShares();
        takeX = Math.mulDiv(shares, bk.x, st, Math.Rounding.Ceil);
        takeY = Math.mulDiv(shares, bk.y, st, Math.Rounding.Ceil);
        bk.x += takeX;
        bk.y += takeY;
        id = _newLot(bk, owner);
        _resize(bk, id, shares);
    }

    /// @notice Burn `s` principal shares and `bal` compound balance from a lot; pays both tokens pro rata.
    ///         A partial principal withdrawal keeps the lot's place in line.
    function withdraw(Book storage bk, uint256 id, address owner, uint256 s, uint256 bal)
        internal
        returns (uint256 outX, uint256 outY)
    {
        Lot storage lot = _own(bk, id, owner);
        _checkpoint(bk, id);
        uint256 st = bk.sp + bk.b;
        if (s > lot.s || bal > balanceOf(bk, id)) revert TooMuch();
        if (st - s - bal < MIN_SHARES) revert WouldDrain();
        outX = Math.mulDiv(bk.x, s + bal, st);
        outY = Math.mulDiv(bk.y, s + bal, st);
        if (bal > 0) {
            uint256 burn = Math.mulDiv(bal, RAY, bk.index, Math.Rounding.Ceil);
            lot.n -= Math.min(lot.n, burn);
            bk.b -= bal;
        }
        _resize(bk, id, lot.s - s);
        bk.x -= outX;
        bk.y -= outY;
    }

    /// @notice Turn a lot's compounded balance into a new principal lot at the back of the line.
    function restake(Book storage bk, uint256 id, address owner) internal returns (uint256 newId) {
        Lot storage lot = _own(bk, id, owner);
        _checkpoint(bk, id);
        uint256 bal = balanceOf(bk, id);
        lot.n = 0;
        bk.b -= bal;
        newId = _newLot(bk, owner);
        _resize(bk, newId, bal);
    }

    /// @notice Release a lot's escrowed in-kind payouts. The hook transfers the tokens.
    function claim(Book storage bk, uint256 id, address owner) internal returns (uint256 cx, uint256 cy) {
        Lot storage lot = _own(bk, id, owner);
        _checkpoint(bk, id);
        cx = Math.min(lot.claimX, bk.escrowX);
        cy = Math.min(lot.claimY, bk.escrowY);
        lot.claimX = 0;
        lot.claimY = 0;
        bk.escrowX -= cx;
        bk.escrowY -= cy;
    }

    /// @notice Release the creator's accumulated cut (when not compounding).
    function claimCreator(Book storage bk) internal returns (uint256 cx, uint256 cy) {
        cx = bk.creatorClaimX;
        cy = bk.creatorClaimY;
        bk.creatorClaimX = 0;
        bk.creatorClaimY = 0;
    }

    /// @notice Bring a lot's books up to date (also the view path: call from a static context to read).
    function poke(Book storage bk, uint256 id) internal returns (uint256 s, uint256 bal, uint256 cx, uint256 cy) {
        if (id == 0 || id > bk.count) revert UnknownLot();
        _checkpoint(bk, id);
        Lot storage lot = bk.lots[id];
        return (lot.s, balanceOf(bk, id), lot.claimX, lot.claimY);
    }

    function balanceOf(Book storage bk, uint256 id) internal view returns (uint256) {
        return Math.mulDiv(bk.lots[id].n, bk.index, RAY);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _own(Book storage bk, uint256 id, address owner) private view returns (Lot storage lot) {
        if (id == 0 || id > bk.count) revert UnknownLot();
        lot = bk.lots[id];
        if (lot.owner != owner) revert NotOwner();
    }

    function _newLot(Book storage bk, address owner) private returns (uint256 id) {
        id = bk.count + 1;
        // lazy append: a new node covers (id - lowbit(id), id]; the new value is 0
        int256 lowStart = int256(id - _low(id));
        bk.fs[id] = _prefix(bk, 3, id - 1) - _prefix(bk, 3, uint256(lowStart));
        bk.fc0[id] = _prefix(bk, 0, id - 1) - _prefix(bk, 0, uint256(lowStart));
        bk.fc1[id] = _prefix(bk, 1, id - 1) - _prefix(bk, 1, uint256(lowStart));
        bk.fc2[id] = _prefix(bk, 2, id - 1) - _prefix(bk, 2, uint256(lowStart));
        bk.count = id;
        bk.lots[id].owner = owner;
        _snapshot(bk, id);
    }

    function _px(Book storage bk, uint256 id, uint8 k) private view returns (int256) {
        return _prefix(bk, k, id - 1) + _prefix(bk, 3, id - 1) * int256(bk.a2[k]);
    }

    function _snapshot(Book storage bk, uint256 id) private {
        Lot storage lot = bk.lots[id];
        for (uint8 k = 0; k < 3; k++) {
            lot.snapA1[k] = bk.a1[k];
            lot.snapA2[k] = bk.a2[k];
            lot.snapPX[k] = _px(bk, id, k);
        }
        lot.snapTx = bk.compX;
        lot.snapTy = bk.compY;
    }

    function _reward(Book storage bk, uint256 id, uint8 k) private view returns (uint256) {
        Lot storage lot = bk.lots[id];
        uint256 s = lot.s;
        if (s == 0) return 0;
        uint256 d1 = bk.a1[k] - lot.snapA1[k];
        uint256 d2 = bk.a2[k] - lot.snapA2[k];
        int256 dpxS = _px(bk, id, k) - lot.snapPX[k];
        uint256 dpx = dpxS > 0 ? uint256(dpxS) : 0;
        uint256 plus = Math.mulDiv(7 * s, d1, RAY);
        uint256 minus = Math.mulDiv(29 * s, Math.mulDiv(s, d2, K2, Math.Rounding.Ceil), 10 * RAY, Math.Rounding.Ceil)
            + Math.mulDiv(58 * s, dpx, 10 * K2 * RAY, Math.Rounding.Ceil);
        return plus > minus ? plus - minus : 0;
    }

    function _checkpoint(Book storage bk, uint256 id) private {
        Lot storage lot = bk.lots[id];
        uint256 rsh = _reward(bk, id, SH);
        uint256 rcx = _reward(bk, id, CX);
        uint256 rcy = _reward(bk, id, CY);
        lot.n += rsh;
        uint256 bal = Math.mulDiv(lot.n, bk.index, RAY);
        lot.claimX += rcx + Math.mulDiv(bal, bk.compX - lot.snapTx, RAY);
        lot.claimY += rcy + Math.mulDiv(bal, bk.compY - lot.snapTy, RAY);
        _snapshot(bk, id);
    }

    function _resize(Book storage bk, uint256 id, uint256 newS) private {
        _checkpoint(bk, id);
        Lot storage lot = bk.lots[id];
        int256 d = int256(newS) - int256(lot.s);
        for (uint8 k = 0; k < 3; k++) {
            _add(bk, k, id, -d * int256(bk.a2[k]));
        }
        _add(bk, 3, id, d);
        lot.s = newS;
        bk.sp = _addSigned(bk.sp, d);
        _snapshot(bk, id);
    }

    function _tree(Book storage bk, uint8 t) private view returns (mapping(uint256 => int256) storage) {
        if (t == 0) return bk.fc0;
        if (t == 1) return bk.fc1;
        if (t == 2) return bk.fc2;
        return bk.fs;
    }

    function _prefix(Book storage bk, uint8 t, uint256 i) private view returns (int256 sum) {
        mapping(uint256 => int256) storage tr = _tree(bk, t);
        while (i > 0) {
            sum += tr[i];
            i -= _low(i);
        }
    }

    function _add(Book storage bk, uint8 t, uint256 i, int256 d) private {
        if (d == 0) return;
        mapping(uint256 => int256) storage tr = _tree(bk, t);
        uint256 n = bk.count;
        while (i <= n) {
            tr[i] += d;
            i += _low(i);
        }
    }

    function _low(uint256 i) private pure returns (uint256) {
        unchecked {
            return i & (0 - i);
        }
    }

    function _addSigned(uint256 a, int256 d) private pure returns (uint256) {
        return d >= 0 ? a + uint256(d) : a - uint256(-d);
    }
}

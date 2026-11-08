// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedPointMathLib as FPM} from "./vendor/FixedPointMathLib.sol";
import {DiscipleSwapMath as SM} from "./DiscipleSwapMath.sol";

/// @title Disciple flat-centre curve (v0.2)
/// @notice Same pricing inputs as DiscipleSwapMath (k = kBuy or kSell in WAD, seed ratio T and boundary p in X128),
///         but the marginal price is FLAT near the centre:
///             price(r) = k * T * (r/T)^LAM        for |ln(r/T)| <= W   (the band; r = v/u)
///             price(r) = kLow  * r               below the band,  kLow  = k * e^( W*BETA)
///             price(r) = kHigh * r               above the band,  kHigh = k * e^(-W*BETA)
///         with BETA = 1 - LAM. Outside the band it is today's curve (v * u^k constant), so a side never runs dry;
///         the pieces meet at the same price. Inside the band the path keeps
///             k * u^BETA + (v/T)^BETA  constant,
///         which gives every fill a closed form. The price depends on r only, so deposits at the pool ratio do not
///         move it (like the v0.1 curve). Simulated in disciple-sim/v0/disciple_sim_lam.py (lam_grid.py).
///
///         Match boundary p as in v0.1: a buy never pays less than p, a sell never receives more; the fill runs on
///         the line v + p*u = const until the curve reaches p.
///
///         Rounding favours the pool: every intermediate state is produced by a pool-favourable fill, each pow is
///         rounded against the trader with a 1e-12 relative margin, and the result is the difference between the
///         start and the remaining reserve.
library DiscipleFlatMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q128 = 1 << 128;
    /// @dev Flatness inside the band (0 = constant price, 1 = the v0.1 curve). maker 2026-11-08: 0.05.
    uint256 internal constant LAM = 0.05e18;
    uint256 internal constant BETA = WAD - LAM;
    /// @dev Band half-width in ln(r/T): flat until the reserve ratio is e (2.7x) off the seed ratio. Sim: band 1.0 is
    ///      as good as 0.5 (followup/band_wide.log) and keeps a long one-way run on the flat part (launch gate).
    uint256 internal constant W = 1e18;
    /// @dev Relative safety margin on every pow (covers Solady ln/exp error and the exponent rounding).
    uint256 internal constant REL = 1e12;
    /// @dev expWad(W) and expWad(W * BETA / WAD), precomputed (gas); DiscipleFlatMath.t.sol checks them.
    uint256 internal constant EW = 2718281828459045235;
    uint256 internal constant EWB = 2585709659315846199;

    uint8 internal constant LOW = 0;
    uint8 internal constant BAND = 1;
    uint8 internal constant HIGH = 2;

    error TradeTooLarge();

    struct Curve {
        uint256 t; // X128
        uint256 k; // WAD
        uint256 kLow; // WAD
        uint256 kHigh; // WAD
        uint256 rL; // X128 lower band edge
        uint256 rH; // X128 upper band edge
    }

    function curve(uint256 tX128, uint256 k) internal pure returns (Curve memory c) {
        uint256 eW = EW;
        uint256 eWB = EWB;
        c.t = tX128;
        c.k = k;
        c.kLow = Math.mulDiv(k, eWB, WAD);
        c.kHigh = Math.mulDiv(k, WAD, eWB);
        c.rL = Math.mulDiv(tX128, WAD, eW);
        c.rH = Math.mulDiv(tX128, eW, WAD);
    }

    // ---------------------------------------------------------------------------------------------
    // Fills (same signatures and meaning as DiscipleSwapMath, plus T)
    // ---------------------------------------------------------------------------------------------

    /// @notice Quote in -> coin out, rounded down.
    function buyExactIn(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 tX128, uint256 q)
        internal
        pure
        returns (uint256)
    {
        if (q == 0) return 0;
        Curve memory c = curve(tX128, k);
        uint256 u = u0;
        uint256 v = v0;
        uint8 reg = _region(c, Math.mulDiv(v, Q128, u));
        if (p != 0) {
            (uint256 rb, uint8 regb) = _boundRoot(c, p);
            if (Math.mulDiv(v, Q128, u) < rb) {
                (uint256 ub, uint256 vb) = _linePoint(u, v, p, rb);
                if (vb > v && ub < u) {
                    if (q <= vb - v) return Math.mulDiv(q, Q128, p);
                    (q, u, v, reg) = (q - (vb - v), ub, vb, regb);
                }
            }
        }
        while (true) {
            if (reg == HIGH) {
                u -= SM.buyExactIn(u, v, c.kHigh, 0, q);
                break;
            }
            uint256 qe = _quoteToTop(c, u, v, reg);
            if (q <= qe) {
                u -= _segBuyIn(c, u, v, reg, q);
                break;
            }
            u -= _segBuyIn(c, u, v, reg, qe);
            v += qe;
            q -= qe;
            reg++;
        }
        return u < u0 ? u0 - u : 0;
    }

    /// @notice Coin out -> quote in, rounded up.
    function buyExactOut(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 tX128, uint256 out)
        internal
        pure
        returns (uint256)
    {
        if (out == 0) return 0;
        if (out >= u0) revert SM.InsufficientReserve();
        Curve memory c = curve(tX128, k);
        uint256 u = u0;
        uint256 v = v0;
        uint8 reg = _region(c, Math.mulDiv(v, Q128, u));
        if (p != 0) {
            (uint256 rb, uint8 regb) = _boundRoot(c, p);
            if (Math.mulDiv(v, Q128, u) < rb) {
                (uint256 ub, uint256 vb) = _linePoint(u, v, p, rb);
                if (vb > v && ub < u) {
                    if (out <= u - ub) return Math.mulDiv(out, p, Q128, Math.Rounding.Ceil);
                    (out, u, v, reg) = (out - (u - ub), ub, vb, regb);
                }
            }
        }
        while (true) {
            if (reg == HIGH) {
                v += SM.buyExactOut(u, v, c.kHigh, 0, out);
                break;
            }
            uint256 qe = _quoteToTop(c, u, v, reg);
            uint256 ce = _segBuyIn(c, u, v, reg, qe);
            if (out <= ce) {
                v += _segBuyOut(c, u, v, reg, out);
                break;
            }
            u -= ce;
            v += qe;
            out -= ce;
            reg++;
        }
        return v - v0;
    }

    /// @notice Coin in -> quote out, rounded down.
    function sellExactIn(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 tX128, uint256 q)
        internal
        pure
        returns (uint256)
    {
        if (q == 0) return 0;
        Curve memory c = curve(tX128, k);
        uint256 u = u0;
        uint256 v = v0;
        uint8 reg = _region(c, Math.mulDiv(v, Q128, u));
        if (p != 0) {
            (uint256 rb, uint8 regb) = _boundRoot(c, p);
            if (Math.mulDiv(v, Q128, u) > rb) {
                (uint256 ub, uint256 vb) = _linePoint(u, v, p, rb);
                if (ub > u && vb < v) {
                    if (q <= ub - u) return Math.mulDiv(q, p, Q128);
                    (q, u, v, reg) = (q - (ub - u), ub, vb, regb);
                }
            }
        }
        while (true) {
            if (reg == LOW) {
                v -= SM.sellExactIn(u, v, c.kLow, 0, q);
                break;
            }
            uint256 ce = _coinToBottom(c, u, v, reg);
            if (q <= ce) {
                v -= _segSellIn(c, u, v, reg, q);
                break;
            }
            v -= _segSellIn(c, u, v, reg, ce);
            u += ce;
            q -= ce;
            reg--;
        }
        return v < v0 ? v0 - v : 0;
    }

    /// @notice Quote out -> coin in, rounded up.
    function sellExactOut(uint256 u0, uint256 v0, uint256 k, uint256 p, uint256 tX128, uint256 out)
        internal
        pure
        returns (uint256)
    {
        if (out == 0) return 0;
        if (out >= v0) revert SM.InsufficientReserve();
        Curve memory c = curve(tX128, k);
        uint256 u = u0;
        uint256 v = v0;
        uint8 reg = _region(c, Math.mulDiv(v, Q128, u));
        if (p != 0) {
            (uint256 rb, uint8 regb) = _boundRoot(c, p);
            if (Math.mulDiv(v, Q128, u) > rb) {
                (uint256 ub, uint256 vb) = _linePoint(u, v, p, rb);
                if (ub > u && vb < v) {
                    if (out <= v - vb) return Math.mulDiv(out, Q128, p, Math.Rounding.Ceil);
                    (out, u, v, reg) = (out - (v - vb), ub, vb, regb);
                }
            }
        }
        while (true) {
            if (reg == LOW) {
                u += SM.sellExactOut(u, v, c.kLow, 0, out);
                break;
            }
            uint256 ce = _coinToBottom(c, u, v, reg);
            uint256 qe = _segSellIn(c, u, v, reg, ce);
            if (out <= qe) {
                u += _segSellOut(c, u, v, reg, out);
                break;
            }
            u += ce;
            v -= qe;
            out -= qe;
            reg--;
        }
        return u - u0;
    }

    /// @notice Curve price (quote raw per coin raw, X128) at ratio r, for views and tests.
    function price(Curve memory c, uint256 r) internal pure returns (uint256) {
        uint8 reg = _region(c, r);
        if (reg == LOW) return Math.mulDiv(r, c.kLow, WAD);
        if (reg == HIGH) return Math.mulDiv(r, c.kHigh, WAD);
        return Math.mulDiv(Math.mulDiv(c.t, c.k, WAD), _pow(Math.mulDiv(r, WAD, c.t), LAM, true), WAD);
    }

    // ---------------------------------------------------------------------------------------------
    // Segments
    // ---------------------------------------------------------------------------------------------

    function _region(Curve memory c, uint256 r) private pure returns (uint8) {
        if (r < c.rL) return LOW;
        if (r >= c.rH) return HIGH;
        return BAND;
    }

    /// @dev Quote a buy must pay to move from (u, v) in region `reg` (LOW or BAND) to the region's top edge.
    function _quoteToTop(Curve memory c, uint256 u, uint256 v, uint8 reg) private pure returns (uint256) {
        uint256 r = Math.mulDiv(v, Q128, u);
        uint256 ue;
        uint256 re;
        if (reg == LOW) {
            re = c.rL;
            if (r >= re) return 0;
            // v u^kLow const and v = re u  ->  ue = u (r/re)^(1/(1+kLow))
            ue = Math.mulDiv(u, _pow(Math.mulDiv(r, WAD, re), Math.mulDiv(WAD, WAD, WAD + c.kLow), false), WAD);
        } else {
            re = c.rH;
            if (r >= re) return 0;
            // k u^B + (v/T)^B const  ->  (ue/u)^B = (k + (r/T)^B) / (k + (re/T)^B)
            uint256 zb = _pow(Math.mulDiv(r, WAD, c.t), BETA, false);
            uint256 zeb = _pow(Math.mulDiv(re, WAD, c.t), BETA, true);
            uint256 x = Math.mulDiv(c.k + zb, WAD, c.k + zeb);
            ue = Math.mulDiv(u, _pow(x, Math.mulDiv(WAD, WAD, BETA), false), WAD);
        }
        uint256 ve = Math.mulDiv(re, ue, Q128);
        return ve > v ? ve - v : 0;
    }

    /// @dev Coin a sell must bring to move from (u, v) in region `reg` (HIGH or BAND) to the region's bottom edge.
    function _coinToBottom(Curve memory c, uint256 u, uint256 v, uint8 reg) private pure returns (uint256) {
        uint256 r = Math.mulDiv(v, Q128, u);
        uint256 ue;
        if (reg == HIGH) {
            if (r <= c.rH) return 0;
            ue = Math.mulDiv(u, _pow(Math.mulDiv(r, WAD, c.rH), Math.mulDiv(WAD, WAD, WAD + c.kHigh), false), WAD);
        } else {
            if (r <= c.rL) return 0;
            uint256 zb = _pow(Math.mulDiv(r, WAD, c.t), BETA, false);
            uint256 zeb = _pow(Math.mulDiv(c.rL, WAD, c.t), BETA, true);
            uint256 x = Math.mulDiv(c.k + zb, WAD, c.k + zeb);
            ue = Math.mulDiv(u, _pow(x, Math.mulDiv(WAD, WAD, BETA), false), WAD);
        }
        return ue > u ? ue - u : 0;
    }

    /// @dev Coin out for quote in q within one region (LOW = CP with kLow, BAND = power sum), rounded down.
    function _segBuyIn(Curve memory c, uint256 u, uint256 v, uint8 reg, uint256 q) private pure returns (uint256) {
        if (q == 0) return 0;
        if (reg == LOW) return SM.buyExactIn(u, v, c.kLow, 0, q);
        // (u1/u)^B = 1 - rho ((v+q)/v)^B - 1),  rho = (r/T)^B / k   (rho and the pow rounded down)
        uint256 rho = _rho(c, u, v, false);
        uint256 g = _pow(Math.mulDiv(v + q, WAD, v), BETA, false);
        if (g <= WAD) return 0;
        uint256 d = Math.mulDiv(rho, g - WAD, WAD);
        if (d >= WAD) revert TradeTooLarge();
        uint256 u1 = Math.mulDiv(u, _pow(WAD - d, Math.mulDiv(WAD, WAD, BETA), true), WAD, Math.Rounding.Ceil);
        return u1 < u ? u - u1 : 0;
    }

    /// @dev Quote in for coin out `out` within one region, rounded up.
    function _segBuyOut(Curve memory c, uint256 u, uint256 v, uint8 reg, uint256 out) private pure returns (uint256) {
        if (reg == LOW) return SM.buyExactOut(u, v, c.kLow, 0, out);
        // (v1/v)^B = 1 + (1 - ((u-out)/u)^B) / rho   (rho down, pow down)
        uint256 rho = _rho(c, u, v, false);
        uint256 h = _pow(Math.mulDiv(u - out, WAD, u), BETA, false);
        uint256 y = WAD + Math.mulDiv(h < WAD ? WAD - h : 0, WAD, rho, Math.Rounding.Ceil);
        uint256 v1 =
            Math.mulDiv(v, _pow(y, Math.mulDiv(WAD, WAD, BETA, Math.Rounding.Ceil), true), WAD, Math.Rounding.Ceil);
        return v1 - v;
    }

    /// @dev Quote out for coin in q within one region (HIGH = CP with kHigh, BAND = power sum), rounded down.
    function _segSellIn(Curve memory c, uint256 u, uint256 v, uint8 reg, uint256 q) private pure returns (uint256) {
        if (q == 0) return 0;
        if (reg == HIGH) return SM.sellExactIn(u, v, c.kHigh, 0, q);
        // (v1/v)^B = 1 - (((u+q)/u)^B - 1) / rho   (rho up, pow down)
        uint256 rho = _rho(c, u, v, true);
        uint256 g = _pow(Math.mulDiv(u + q, WAD, u), BETA, false);
        if (g <= WAD) return 0;
        uint256 d = Math.mulDiv(g - WAD, WAD, rho);
        if (d >= WAD) revert TradeTooLarge();
        uint256 v1 = Math.mulDiv(v, _pow(WAD - d, Math.mulDiv(WAD, WAD, BETA), true), WAD, Math.Rounding.Ceil);
        return v1 < v ? v - v1 : 0;
    }

    /// @dev Coin in for quote out `out` within one region, rounded up.
    function _segSellOut(Curve memory c, uint256 u, uint256 v, uint8 reg, uint256 out) private pure returns (uint256) {
        if (reg == HIGH) return SM.sellExactOut(u, v, c.kHigh, 0, out);
        // (u1/u)^B = 1 + rho (1 - ((v-out)/v)^B)   (rho up, pow down)
        uint256 rho = _rho(c, u, v, true);
        uint256 h = _pow(Math.mulDiv(v - out, WAD, v), BETA, false);
        uint256 y = WAD + Math.mulDiv(rho, h < WAD ? WAD - h : 0, WAD, Math.Rounding.Ceil);
        uint256 u1 =
            Math.mulDiv(u, _pow(y, Math.mulDiv(WAD, WAD, BETA, Math.Rounding.Ceil), true), WAD, Math.Rounding.Ceil);
        return u1 - u;
    }

    /// @dev rho = (r/T)^BETA / k, WAD.
    function _rho(Curve memory c, uint256 u, uint256 v, bool up) private pure returns (uint256) {
        uint256 z = Math.mulDiv(v, WAD, u);
        z = Math.mulDiv(z, Q128, c.t, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
        return Math.mulDiv(_pow(z, BETA, up), WAD, c.k, up ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    // ---------------------------------------------------------------------------------------------
    // Boundary
    // ---------------------------------------------------------------------------------------------

    /// @dev Ratio where the curve price equals p, and its region.
    function _boundRoot(Curve memory c, uint256 p) private pure returns (uint256 rb, uint8 reg) {
        uint256 lowTop = Math.mulDiv(c.rL, c.kLow, WAD); // price at rL
        uint256 highBot = Math.mulDiv(c.rH, c.kHigh, WAD); // price at rH
        if (p < lowTop) return (Math.mulDiv(p, WAD, c.kLow), LOW);
        if (p >= highBot) return (Math.mulDiv(p, WAD, c.kHigh), HIGH);
        // p = k T (r/T)^LAM  ->  r = T (p / (k T))^(1/LAM)
        uint256 x = Math.mulDiv(p, WAD, Math.mulDiv(c.t, c.k, WAD));
        rb = Math.mulDiv(c.t, _pow(x, Math.mulDiv(WAD, WAD, LAM), false), WAD);
        reg = BAND;
    }

    /// @dev Where the line v + p*u = const through (u, v) reaches ratio rb. Both coordinates rounded up.
    function _linePoint(uint256 u, uint256 v, uint256 p, uint256 rb) private pure returns (uint256 ub, uint256 vb) {
        uint256 kc = v + Math.mulDiv(p, u, Q128, Math.Rounding.Ceil);
        ub = Math.mulDiv(kc, Q128, rb + p, Math.Rounding.Ceil);
        vb = Math.mulDiv(rb, ub, Q128, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------------------------------------
    // pow
    // ---------------------------------------------------------------------------------------------

    /// @dev x^e for x > 0 (both WAD), rounded up or down with a 1e-12 relative margin.
    function _pow(uint256 x, uint256 e, bool up) private pure returns (uint256 r) {
        if (x == 0) return up ? 1 : 0;
        if (x == WAD) return WAD;
        if (x > uint256(type(int256).max)) revert TradeTooLarge();
        int256 l = FPM.lnWad(int256(x));
        int256 y = (l * int256(e)) / int256(WAD);
        if (y > 130e18) revert TradeTooLarge();
        r = uint256(FPM.expWad(y));
        uint256 m = r / REL + 2;
        if (up) r += m;
        else r = r > m ? r - m : 0;
    }
}

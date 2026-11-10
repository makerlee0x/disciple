"""Integer mirror of the Solidity DiscipleSwapMath library, plus an 80-digit Decimal reference.

Curve (lambda = 1): marginal price = k * v/u, with k = C*G_buy on buys and C/G_sell on sells,
C = P_ref / T, G = H / (1 - f). G_sell defaults to G_buy. Invariant on a curve segment: v * u^k = const.
Match boundary p (X128 price): buys never below p (linear segment v + p u = const while k v < p u),
sells never above p (linear while k v > p u). p == 0 means no boundary.
Reserves are raw token units, prices are X128 (raw quote per raw coin * 2^128), k/G/H are WAD."""
from fpm import lnWad, expWad, D

WAD = 10**18
Q128 = 1 << 128
FEE_DEN = 10**6
LN_SLACK = 1000         # wei of ln against the trader: covers Solady ln error (<= 1.05 wei) and keeps split <= whole
EXP_SLACK = 2            # wei of exp added against the trader (Solady exp error <= ~1 wei below 1.0)
EXP_MAX = 135305999368893231589

def mulDiv(a, b, d): return a * b // d
def mulDivUp(a, b, d): return -(-(a * b) // d)

# ---- pow helpers, always rounded against the trader (result up) --------------------------
def decay_up(base, num, den, cN, cD):
    """base * (den/num)^(cN/cD) with num >= den, rounded up."""
    assert num >= den > 0
    ratio = mulDiv(num, WAD, den)
    if ratio <= WAD:
        return base
    ln = lnWad(ratio) - LN_SLACK
    if ln <= 0:
        return base
    e = expWad(-mulDiv(ln, cN, cD)) + EXP_SLACK
    if e >= WAD:
        return base
    return mulDivUp(base, e, WAD)

def grow_up(base, num, den, cN, cD):
    """base * (num/den)^(cN/cD) with num >= den, rounded up."""
    assert num >= den > 0
    ratio = mulDivUp(num, WAD, den)
    y = mulDivUp(max(lnWad(ratio), 0) + LN_SLACK, cN, cD)
    if y >= EXP_MAX:
        raise OverflowError("TradeTooLarge")
    e = expWad(y)
    e += e // 10**17 + EXP_SLACK
    return mulDivUp(base, e, WAD)

def bound_point(u0, v0, k, p):
    """Where the linear segment through (u0, v0) at price p meets marginal k v/u = p. Both rounded up."""
    K = v0 + mulDivUp(p, u0, Q128)
    vb = mulDivUp(K, WAD, WAD + k)
    ub = mulDivUp(mulDivUp(vb, k, WAD), Q128, p)
    return ub, vb

# ---- the four fills --------------------------------------------------------------------
def buy_exact_in(u0, v0, k, p, Q):
    """Quote in -> coin out (rounded down)."""
    if Q == 0: return 0
    ub, vb = u0, v0
    if p:
        ub2, vb2 = bound_point(u0, v0, k, p)
        if v0 < vb2:
            if Q <= vb2 - v0:
                return mulDiv(Q, Q128, p)
            ub, vb = ub2, vb2
    u1 = decay_up(ub, v0 + Q, vb, WAD, k)
    return u0 - u1 if u1 < u0 else 0

def buy_exact_out(u0, v0, k, p, q):
    """Coin out -> quote in (rounded up)."""
    if q == 0: return 0
    assert q < u0, "InsufficientReserve"
    ub, vb = u0, v0
    if p:
        ub2, vb2 = bound_point(u0, v0, k, p)
        if v0 < vb2:
            if ub2 < u0 and q <= u0 - ub2:
                return mulDivUp(q, p, Q128)
            ub, vb = ub2, vb2
    v1 = grow_up(vb, ub, u0 - q, k, WAD)
    return v1 - v0

def sell_exact_in(u0, v0, k, p, Qc):
    """Coin in -> quote out (rounded down)."""
    if Qc == 0: return 0
    ub, vb = u0, v0
    if p:
        ub2, vb2 = bound_point(u0, v0, k, p)
        if v0 > vb2:
            if Qc <= ub2 - u0:
                return mulDiv(Qc, p, Q128)
            ub, vb = ub2, vb2
    v1 = decay_up(vb, u0 + Qc, ub, k, WAD)
    return v0 - v1 if v1 < v0 else 0

def sell_exact_out(u0, v0, k, p, w):
    """Quote out -> coin in (rounded up)."""
    if w == 0: return 0
    assert w < v0, "InsufficientReserve"
    ub, vb = u0, v0
    if p:
        ub2, vb2 = bound_point(u0, v0, k, p)
        if v0 > vb2:
            if w <= v0 - vb2:
                return mulDivUp(w, Q128, p)
            ub, vb = ub2, vb2
    u1 = grow_up(ub, vb, v0 - w, WAD, k)
    return u1 - u0

# ---- pricing inputs ----------------------------------------------------------------------
def premium(h0, tau, elapsed):
    """H = 1 + h0 * (1 - elapsed/tau) for elapsed < tau, else 1. WAD, rounded up (linear fade)."""
    if h0 == 0: return WAD
    if elapsed >= tau: return WAD
    return WAD + mulDivUp(h0, tau - elapsed, tau)

def markup(H, fee):
    """G = H / (1 - f), fee in pips (1e6 = 100%), rounded up."""
    return mulDivUp(H, FEE_DEN, FEE_DEN - fee)

def slopes(pref, T, G, G_sell=None):
    """(k_buy rounded up, k_sell rounded down); pref and T are X128.
    G_sell defaults to G. The hook passes a fee-only markup on the side that does not benefit from the lag."""
    if G_sell is None:
        G_sell = G
    return mulDivUp(pref, G, T), mulDiv(mulDiv(pref, WAD, T), WAD, G_sell)

def moved_beyond(ref, price, bps):
    if ref == 0: return True
    return abs(price - ref) * 10_000 // ref >= bps

def match_bounds(src_ask, src_bid, edge_bps):
    """Ask floor (up) and bid ceiling (down), X128."""
    return mulDivUp(src_ask, 10_000 - edge_bps, 10_000), mulDiv(src_bid, 10_000 + edge_bps, 10_000)

# ---- exact reference (no rounding) -----------------------------------------------------------
def _ref_point(u0, v0, k, p):
    K = v0 + p * u0
    vb = K / (1 + k)
    return vb * k / p, vb

def ref_buy_exact_in(u0, v0, k, p, Q):
    u0, v0, Q = D(u0), D(v0), D(Q); k = D(k) / WAD
    ub, vb = u0, v0
    if p:
        p = D(p) / Q128; ub2, vb2 = _ref_point(u0, v0, k, p)
        if v0 < vb2:
            if Q <= vb2 - v0: return Q / p
            ub, vb = ub2, vb2
    return u0 - ub * (vb / (v0 + Q)) ** (1 / k)

def ref_buy_exact_out(u0, v0, k, p, q):
    u0, v0, q = D(u0), D(v0), D(q); k = D(k) / WAD
    ub, vb = u0, v0
    if p:
        p = D(p) / Q128; ub2, vb2 = _ref_point(u0, v0, k, p)
        if v0 < vb2:
            if q <= u0 - ub2: return q * p
            ub, vb = ub2, vb2
    return vb * (ub / (u0 - q)) ** k - v0

def ref_sell_exact_in(u0, v0, k, p, Qc):
    u0, v0, Qc = D(u0), D(v0), D(Qc); k = D(k) / WAD
    ub, vb = u0, v0
    if p:
        p = D(p) / Q128; ub2, vb2 = _ref_point(u0, v0, k, p)
        if v0 > vb2:
            if Qc <= ub2 - u0: return Qc * p
            ub, vb = ub2, vb2
    return v0 - vb * (ub / (u0 + Qc)) ** k

def ref_sell_exact_out(u0, v0, k, p, w):
    u0, v0, w = D(u0), D(v0), D(w); k = D(k) / WAD
    ub, vb = u0, v0
    if p:
        p = D(p) / Q128; ub2, vb2 = _ref_point(u0, v0, k, p)
        if v0 > vb2:
            if w <= v0 - vb2: return w / p
            ub, vb = ub2, vb2
    return ub * (vb / (v0 - w)) ** (1 / k) - u0

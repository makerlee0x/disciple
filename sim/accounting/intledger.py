"""Integer mirror of fast.py: the exact algorithm the Solidity ledger (DiscipleLedger.sol) runs, with its fixed-point
scales and rounding. Every rounding goes against the LP (toward the pool), so integer claims never exceed what the
exact model (fast.py) pays. compare_int.py checks agreement and conservation on random histories.

Scales:  token amounts and shares in wei;  mark M in X128 (quote wei per coin wei * 2^128);
         q, A1, I, T in RAY (1e27);  A2 = sum ceil(q * 1e18 / Sp) (RAY * 1e18 per share);  c, PX in units of s * A2.
Weights are kept x10 so 4.1 and 1.2 stay integers: W10 = 41 * Sp + 12 * B.
Lot reward per set = 7 s dA1 / RAY - 29 s^2 dA2 / (10 * 1e18 * RAY) - 58 s dPX / (10 * 1e18 * RAY), floored at 0.

Settlement (`settle`) marks the interval's net token flow at the mark it is given (deferred mark for cross-chain),
carries losses pool-wide, latches graduation, and distributes unless `distribute` is False (local mode: results
stay in share value pro rata, no boost and no creator cut).
"""

RAY = 10**27
K2 = 10**18
Q128 = 1 << 128
SETS = ("sh", "cx", "cy")


def mul_div(a, b, d):
    return a * b // d


def mul_div_up(a, b, d):
    return -((-a * b) // d)


class Fenwick:
    """Lazy append-only Fenwick tree over signed values (mirrors BoostQueue's layout)."""

    def __init__(self):
        self.t = {}
        self.n = 0

    @staticmethod
    def low(i):
        return i & -i

    def prefix(self, i):
        s = 0
        while i > 0:
            s += self.t.get(i, 0)
            i -= i & -i
        return s

    def push(self, val):
        i = self.n + 1
        self.t[i] = val + self.prefix(i - 1) - self.prefix(i - (i & -i))
        self.n = i

    def add(self, i, d):
        while i <= self.n:
            self.t[i] = self.t.get(i, 0) + d
            i += i & -i


class Lot:
    def __init__(self, id, owner):
        self.id, self.owner = id, owner
        self.s = 0          # principal shares
        self.n = 0          # compound units; balance b = n * I / RAY
        self.c = {k: 0 for k in SETS}
        self.snapA1 = {k: 0 for k in SETS}
        self.snapA2 = {k: 0 for k in SETS}
        self.snapPX = {k: 0 for k in SETS}
        self.snapT = {"cx": 0, "cy": 0}
        self.claim = [0, 0]


class Ledger:
    MIN_SHARES = 10**6  # shares that can never be withdrawn, so the pool never drains to rounding dust
    TARGET_BPS = 1200
    CREATOR_BPS = 1200

    def __init__(self, creator, x, y, M):
        self.x, self.y = x, y
        self.creator, self.creator_compounds = creator, False
        self.lots = {}
        self.order = []
        self.Fs = Fenwick()
        self.Fc = {k: Fenwick() for k in SETS}
        self.dx = self.dy = 0
        self.L = 0
        self.graduated = False
        self.Sp = 0
        self.B = 0
        self.I = RAY
        self.A1 = {k: 0 for k in SETS}
        self.A2 = {k: 0 for k in SETS}
        self.T = {"cx": 0, "cy": 0}
        self.escrow = [0, 0]
        self.creator_claim = [0, 0]
        self.creator_lot = None
        l = self._new_lot(creator)
        self._resize(l, self.value(M))

    # ---- helpers -------------------------------------------------------------------------------------
    def value(self, M):
        return mul_div(self.x, M, Q128) + self.y

    def _PX(self, l, k):
        return self.Fc[k].prefix(l.id - 1) + self.Fs.prefix(l.id - 1) * self.A2[k]

    def _snapshot(self, l):
        for k in SETS:
            l.snapA1[k] = self.A1[k]
            l.snapA2[k] = self.A2[k]
            l.snapPX[k] = self._PX(l, k)
        l.snapT = dict(self.T)

    def _reward(self, l, k):
        s = l.s
        if s == 0:
            return 0
        d1 = self.A1[k] - l.snapA1[k]
        d2 = self.A2[k] - l.snapA2[k]
        dpx = max(0, self._PX(l, k) - l.snapPX[k])
        r = mul_div(7 * s, d1, RAY)
        r -= mul_div_up(29 * s, mul_div_up(s, d2, K2), 10 * RAY)
        r -= mul_div_up(58 * s, dpx, 10 * K2 * RAY)
        return max(0, r)

    def _checkpoint(self, l):
        r = {k: self._reward(l, k) for k in SETS}
        l.n += r["sh"]
        b = mul_div(l.n, self.I, RAY)
        l.claim[0] += r["cx"] + mul_div(b, self.T["cx"] - l.snapT["cx"], RAY)
        l.claim[1] += r["cy"] + mul_div(b, self.T["cy"] - l.snapT["cy"], RAY)
        self._snapshot(l)

    def _resize(self, l, new):
        self._checkpoint(l)
        d = new - l.s
        for k in SETS:
            dc = -d * self.A2[k]
            l.c[k] += dc
            self.Fc[k].add(l.id, dc)
        self.Fs.add(l.id, d)
        l.s = new
        self.Sp += d
        self._snapshot(l)

    def _new_lot(self, owner):
        i = len(self.order) + 1
        l = Lot(i, owner)
        self.lots[i] = l
        self.order.append(i)
        self.Fs.push(0)
        for k in SETS:
            self.Fc[k].push(0)
        self._snapshot(l)
        return l

    def balance(self, l):
        return mul_div(l.n, self.I, RAY)

    # ---- trading and settlement --------------------------------------------------------------------
    def swap(self, dx, dy):
        self.x += dx
        self.y += dy
        self.dx += dx
        self.dy += dy

    def settle(self, M, tvl, distribute=True):
        E = self.dy + (mul_div(self.dx, M, Q128) if self.dx >= 0 else -mul_div_up(-self.dx, M, Q128))
        self.dx = self.dy = 0
        if not distribute:
            return 0
        if E >= self.L:
            Q, self.L = E - self.L, 0
        else:
            Q, self.L = 0, self.L - E
        V = self.value(M)
        # Spec: nothing is distributed if Q >= V. We also hold back Q > V/2 (a pathological one-interval gain) so the
        # 1/(V - D) terms stay bounded; it stays in share value pro rata.
        if 0 < Q and 2 * Q <= V:
            self._distribute(Q, V)
        if not self.graduated and tvl > 0 and self.value(M) * 10_000 >= self.TARGET_BPS * tvl:
            self.graduated = True
        return Q

    def _distribute(self, D, V):
        St = self.Sp + self.B
        W10 = 41 * self.Sp + 12 * self.B
        if W10 == 0:
            return
        if not self.graduated:
            LP = D
            # I *= 1 + 1.2 * LP * St / (W * (V - D))
            self.I += mul_div(self.I, 12 * LP * St, W10 * (V - D))
            q = mul_div(mul_div(10 * LP * St, RAY, W10 * (V - D)), RAY, self.I)
            self._accrue("sh", q)
            self.B += mul_div_up(LP, St, V - D)
            return
        cD = mul_div_up(D, self.CREATOR_BPS, 10_000)
        LP = D - cD
        x0, y0 = self.x, self.y
        qx = mul_div(10 * LP * x0, RAY, W10 * V)
        qy = mul_div(10 * LP * y0, RAY, W10 * V)
        self.T["cx"] += mul_div(12 * LP * x0, RAY, W10 * V)
        self.T["cy"] += mul_div(12 * LP * y0, RAY, W10 * V)
        self._accrue("cx", qx)
        self._accrue("cy", qy)
        ex, ey = mul_div_up(x0, LP, V), mul_div_up(y0, LP, V)
        self.x -= ex
        self.y -= ey
        self.escrow[0] += ex
        self.escrow[1] += ey
        if self.creator_compounds:
            if self.creator_lot is None:
                self.creator_lot = self._new_lot(self.creator)
            cl = self.creator_lot
            self._checkpoint(cl)
            add = mul_div(cD, St, V - D)
            cl.n += mul_div(add, RAY, self.I)
            self.B += add
        else:
            cx, cy = mul_div(x0, cD, V), mul_div(y0, cD, V)
            self.creator_claim[0] += cx
            self.creator_claim[1] += cy
            self.x -= cx
            self.y -= cy

    MIN_SP_SLIDE = 10**12  # below this much principal the slide's quadratic term is skipped (overpays dust at most)

    def _accrue(self, k, q):
        self.A1[k] += q
        if self.Sp >= self.MIN_SP_SLIDE:
            self.A2[k] += mul_div_up(q, K2, self.Sp)

    # ---- capital changes (caller settles first) -------------------------------------------------------
    def deposit(self, owner, dx, dy):
        St = self.Sp + self.B
        sh = min(mul_div(dx, St, self.x), mul_div(dy, St, self.y))
        tx, ty = mul_div_up(sh, self.x, St), mul_div_up(sh, self.y, St)
        self.x += tx
        self.y += ty
        l = self._new_lot(owner)
        self._resize(l, sh)
        return l, tx, ty

    def withdraw(self, lot_id, s, b):
        l = self.lots[lot_id]
        self._checkpoint(l)
        St = self.Sp + self.B
        assert s <= l.s and b <= self.balance(l)
        assert St - s - b >= self.MIN_SHARES, "would drain the pool"
        cx, cy = mul_div(self.x, s + b, St), mul_div(self.y, s + b, St)
        if b:
            l.n -= min(l.n, mul_div_up(b, RAY, self.I))
            self.B -= b
        self._resize(l, l.s - s)
        self.x -= cx
        self.y -= cy
        return cx, cy

    def restake(self, lot_id):
        l = self.lots[lot_id]
        self._checkpoint(l)
        b = self.balance(l)
        l.n = 0
        self.B -= b
        nl = self._new_lot(l.owner)
        self.B += 0
        self._resize(nl, b)
        return nl

    def claim(self, lot_id):
        l = self.lots[lot_id]
        self._checkpoint(l)
        c = [min(l.claim[0], self.escrow[0]), min(l.claim[1], self.escrow[1])]
        l.claim = [0, 0]
        self.escrow[0] -= c[0]
        self.escrow[1] -= c[1]
        return c

    def lot_view(self, lot_id):
        l = self.lots[lot_id]
        self._checkpoint(l)
        return l.s, self.balance(l), tuple(l.claim)

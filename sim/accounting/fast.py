"""Efficient form of ledger2.py: every operation is O(1) plus O(log n) Fenwick work (here plain prefix sums,
same algebra). Exact rationals. Must agree with ledger2.py exactly; see compare.py.

Global accumulators per settlement epoch e (rho = LP reward value per unit weight, S = principal shares):
  phase 1 (below graduation, compound):  q = rho / (Ubase * I_e)           -> compound units
  phase 2 (after, pay in kind):           q = rho * x/V  and  rho * y/V     -> coin and quote claims
  for each set k:  A1_k += q,  A2_k += q / S,  principal lot reward = 7 s dA1 - 2.9 s^2 dA2 - 5.8 s dPX
  PX = sum over earlier lots of X_j,  X_j = c_j + s_j * A2_k  (c_j absorbs changes in s_j)
Compound class (flat 1.2x): phase 1 grows the index I by (1 + 1.2 rho / Ubase); phase 2 pays T_k += 1.2 * q_k.
"""
from fractions import Fraction as Fr

TARGET, CREATOR_CUT = Fr(12, 100), Fr(12, 100)
SETS = ("sh", "cx", "cy")


class Lot:
    def __init__(self, id, owner, block):
        self.id, self.owner, self.block = id, owner, block
        self.s = Fr(0); self.n = Fr(0)                      # principal shares, compound units (b = n * I)
        self.c = {k: Fr(0) for k in SETS}
        self.snap = None
        self.claim = [Fr(0), Fr(0)]                           # escrowed coin, quote


class Pool:
    def __init__(self, creator, x, y, M, block=0):
        self.x, self.y = Fr(x), Fr(y)
        self.creator, self.creator_compounds = creator, False
        self.lots, self.next_id, self.block, self.sealed = [], 1, block, block
        self.E = self.L = Fr(0); self.graduated = False; self.creator_on = False
        self.Sp = Fr(0); self.B = Fr(0); self.I = Fr(1)
        self.A1 = {k: Fr(0) for k in SETS}; self.A2 = {k: Fr(0) for k in SETS}
        self.T = {"cx": Fr(0), "cy": Fr(0)}
        self.creator_claim = [Fr(0), Fr(0)]; self.creator_lot = None
        l = self._new_lot(creator); self._resize(l, Fr(x) * Fr(M) + Fr(y))

    # ---- Fenwick-equivalent prefix --------------------------------------------------------
    def _PX(self, l, k):
        tot = Fr(0)
        for j in self.lots:
            if j is l: break
            tot += j.c[k] + j.s * self.A2[k]
        return tot

    def _snapshot(self, l):
        l.snap = ({k: self.A1[k] for k in SETS}, {k: self.A2[k] for k in SETS},
                  {k: self._PX(l, k) for k in SETS}, dict(self.T))

    def _checkpoint(self, l):
        A1s, A2s, PXs, Ts = l.snap
        r = {}
        for k in SETS:
            r[k] = 7 * l.s * (self.A1[k] - A1s[k]) - Fr(29, 10) * l.s ** 2 * (self.A2[k] - A2s[k]) \
                - Fr(58, 10) * l.s * (self._PX(l, k) - PXs[k])
        l.n += r["sh"]
        bnow = l.n * self.I
        l.claim[0] += r["cx"] + bnow * (self.T["cx"] - Ts["cx"])
        l.claim[1] += r["cy"] + bnow * (self.T["cy"] - Ts["cy"])
        self._snapshot(l)

    def _resize(self, l, new):
        self._checkpoint(l) if l.snap else self._snapshot(l)
        d = new - l.s
        for k in SETS:
            l.c[k] -= d * self.A2[k]
        l.s = new; self.Sp += d
        self._snapshot(l)

    def _new_lot(self, owner):
        l = Lot(self.next_id, owner, self.block); self.next_id += 1; self.lots.append(l); self._snapshot(l); return l

    def V(self, M): return Fr(M) * self.x + self.y

    # ---- trading and settlement (O(1)) ---------------------------------------------------------
    def swap(self, dx, dy, M):
        self.x += Fr(dx); self.y += Fr(dy); self.E += Fr(dy) + Fr(M) * Fr(dx)

    def touch(self, block, M, tvl):
        if block > self.sealed:
            self.settle(M, tvl); self.sealed = block
        self.block = block

    def settle(self, M, tvl):
        M, tvl = Fr(M), Fr(tvl)
        Q = max(Fr(0), self.E - self.L); self.L = max(Fr(0), self.L - self.E); self.E = Fr(0)
        V = self.V(M)
        if 0 < Q < V:
            self._distribute(Q, V)
        if tvl > 0:  # creator cut reversible, LP payouts latch (maker, 2026-11-04)
            self.creator_on = self.V(M) >= TARGET * tvl
            self.graduated = self.graduated or self.creator_on
        return Q

    def _distribute(self, D, V):
        Stot = self.Sp + self.B
        c = CREATOR_CUT if self.graduated and self.creator_on else Fr(0)
        LP = (1 - c) * D
        Ubase = (V - D) / Stot
        W = Fr(41, 10) * self.Sp + Fr(6, 5) * self.B
        rho = LP / W
        if not self.graduated:
            self.I *= 1 + Fr(6, 5) * rho / Ubase
            q = {"sh": rho / (Ubase * self.I)}
            self.B += LP / Ubase
        else:
            q = {"cx": rho * self.x / V, "cy": rho * self.y / V}
            cx, cy = self.x * LP / V, self.y * LP / V
            self.T["cx"] += Fr(6, 5) * q["cx"]; self.T["cy"] += Fr(6, 5) * q["cy"]
            x0, y0 = self.x, self.y
            self.x -= cx; self.y -= cy
            if c == 0:
                pass
            elif self.creator_compounds:
                if self.creator_lot is None:
                    self.creator_lot = self._new_lot(self.creator)
                cl = self.creator_lot; self._checkpoint(cl)
                cl.n += c * D / Ubase / self.I; self.B += c * D / Ubase
            else:
                self.creator_claim[0] += x0 * c * D / V; self.creator_claim[1] += y0 * c * D / V
                self.x -= x0 * c * D / V; self.y -= y0 * c * D / V
        for k, v in q.items():
            self.A1[k] += v
            if self.Sp > 0:
                self.A2[k] += v / self.Sp

    # ---- capital changes ------------------------------------------------------------------------
    def deposit(self, owner, dx, dy, M, tvl):
        self.settle(M, tvl)
        a = min(Fr(dx) / self.x, Fr(dy) / self.y)
        St = self.Sp + self.B
        self.x += a * self.x; self.y += a * self.y
        l = self._new_lot(owner); self._resize(l, a * St); return l

    def withdraw(self, lot_id, s, b, M, tvl):
        self.settle(M, tvl)
        l = next(l for l in self.lots if l.id == lot_id)
        self._checkpoint(l)
        f = (Fr(s) + Fr(b)) / (self.Sp + self.B)
        cx, cy = f * self.x, f * self.y
        l.n -= Fr(b) / self.I; self.B -= Fr(b)
        self._resize(l, l.s - Fr(s))
        self.x -= cx; self.y -= cy
        return cx, cy

    def restake(self, lot_id, M, tvl):
        self.settle(M, tvl)
        l = next(l for l in self.lots if l.id == lot_id)
        self._checkpoint(l)
        b = l.n * self.I; l.n = Fr(0); self.B -= b
        nl = self._new_lot(l.owner); self._resize(nl, b); return nl

    # ---- views -------------------------------------------------------------------------------------
    def lot_view(self, lot_id):
        l = next(l for l in self.lots if l.id == lot_id)
        self._checkpoint(l)
        return l.s, l.n * self.I, tuple(l.claim)

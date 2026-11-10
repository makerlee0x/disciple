"""Reference model for the DECIDED design (maker, 2026-11-03), brute force, exact rationals.

Differences from ledger.py (GPT spec v1):
- Boost slides 7x -> 1.2x across the whole principal queue: F(z) = 7z - 2.9 z^2 / S, S = principal shares.
- Compounded earnings are a separate share class held per lot, weighted a flat 1.2x, outside the queue.
- restake(lot) turns a lot's compounded shares into a new principal lot at the back of the queue.
Everything else follows GPT's spec: anchor-marked earnings, pool-wide loss carry, settle every block and before
any capital change, 12% creator cut after latched graduation, in-kind payouts, no distribution if Q >= V.
"""
from fractions import Fraction as Fr

TARGET, CREATOR_CUT = Fr(12, 100), Fr(12, 100)


def F(z, S):
    z, S = Fr(z), Fr(S)
    return Fr(7) * z - Fr(29, 10) * z * z / S if S > 0 else Fr(0)


class Lot:
    def __init__(self, id, owner, s, block):
        self.id, self.owner, self.s, self.b, self.block = id, owner, Fr(s), Fr(0), block


class Pool:
    def __init__(self, creator, x, y, M, block=0):
        self.x, self.y = Fr(x), Fr(y)
        self.creator, self.creator_compounds = creator, False
        self.lots, self.next_id, self.block, self.sealed = [], 1, block, block
        self.E = self.L = Fr(0); self.graduated = False; self.creator_on = False
        self.escrow = {}; self.events = []
        self.creator_lot = None
        self._new_lot(creator, Fr(x) * Fr(M) + Fr(y))

    def _new_lot(self, owner, s):
        l = Lot(self.next_id, owner, s, self.block); self.next_id += 1; self.lots.append(l); return l

    @property
    def S(self): return sum(l.s for l in self.lots)
    @property
    def B(self): return sum(l.b for l in self.lots)
    def V(self, M): return Fr(M) * self.x + self.y

    def swap(self, dx, dy, M):
        self.x += Fr(dx); self.y += Fr(dy); self.E += Fr(dy) + Fr(M) * Fr(dx)
        assert self.x > 0 and self.y > 0

    def touch(self, block, M, tvl):
        if block > self.sealed:
            self.settle(M, tvl); self.sealed = block
        self.block = block

    def settle(self, M, tvl):
        M, tvl = Fr(M), Fr(tvl)
        Q = max(Fr(0), self.E - self.L); self.L = max(Fr(0), self.L - self.E); self.E = Fr(0)
        V = self.V(M)
        on = self.creator_on
        if tvl > 0:
            on = self.creator_on = V >= TARGET * tvl
        if Q > 0:
            if Q >= V:
                self.events.append(("non_distributable", Q))
            else:
                self._distribute(Q, V, M)
        self.graduated = self.graduated or on
        return Q

    def _distribute(self, D, V, M):
        S, Stot = self.S, self.S + self.B
        c = CREATOR_CUT if self.graduated and self.creator_on else Fr(0)
        LP = (1 - c) * D
        Ubase = (V - D) / Stot
        W = Fr(41, 10) * S + Fr(6, 5) * self.B
        ahead = Fr(0); alloc = []
        for l in self.lots:
            w = (F(ahead + l.s, S) - F(ahead, S)) + Fr(6, 5) * l.b
            ahead += l.s
            alloc.append((l, LP * w / W))
        x0, y0 = self.x, self.y
        if not self.graduated:
            for l, r in alloc:
                l.b += r / Ubase
        else:
            for l, r in alloc:
                self._escrow(l.id, x0 * r / V, y0 * r / V)
            if c == 0:
                pass
            elif self.creator_compounds:
                if self.creator_lot is None:
                    self.creator_lot = self._new_lot(self.creator, 0)
                self.creator_lot.b += c * D / Ubase
            else:
                self._escrow("creator", x0 * c * D / V, y0 * c * D / V)

    def _escrow(self, key, cx, cy):
        self.x -= cx; self.y -= cy
        e = self.escrow.setdefault(key, [Fr(0), Fr(0)]); e[0] += cx; e[1] += cy

    def deposit(self, owner, dx, dy, M, tvl):
        self.settle(M, tvl)
        a = min(Fr(dx) / self.x, Fr(dy) / self.y)
        St = self.S + self.B
        self.x += a * self.x; self.y += a * self.y
        return self._new_lot(owner, a * St)

    def withdraw(self, lot_id, s, b, M, tvl):
        self.settle(M, tvl)
        l = next(l for l in self.lots if l.id == lot_id)
        assert l.block < self.block
        s, b = Fr(s), Fr(b); assert s <= l.s and b <= l.b
        f = (s + b) / (self.S + self.B)
        cx, cy = f * self.x, f * self.y
        l.s -= s; l.b -= b; self.x -= cx; self.y -= cy
        return cx, cy

    def restake(self, lot_id, M, tvl):
        self.settle(M, tvl)
        l = next(l for l in self.lots if l.id == lot_id)
        b, l.b = l.b, Fr(0)
        return self._new_lot(l.owner, b)

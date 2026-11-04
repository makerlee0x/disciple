"""Reference model of Disciple LP accounting (GPT ACCOUNTING_SPEC v1, 2026-11-03, plus maker's decisions).

Exact rational arithmetic, brute force over positions. This is the answer key for the Solidity module, not an
efficient implementation. Decisions encoded:
- Earnings ledger: e = dy + M*dx per swap (anchor-marked), minus pool-paid costs. No separate fee term.
- Pool-wide loss carryforward L. Q = max(0, E - L) is the only thing boosted or charged a creator fee.
- Checkpoints: settle at the first interaction of each block and before every deposit or withdrawal (maker).
- Boost: 7x -> 1.2x integrated over the first R shares of the FIFO line, R = 7% of source TVL / share price.
- Below graduation: rewards compound as NEW tail lots (no slot inheritance). After: 12% creator, 88% LPs,
  paid in kind as a basket of both tokens into escrow; the creator may elect to compound instead.
- Graduation (active NAV >= 12% of source TVL) latches and applies from the next interval.
- If Q >= V (backing failure) nothing is distributed; Q is recorded as non-distributable surplus.
"""
from fractions import Fraction as Fr

FRONT, TAIL, SLIDE = Fr(7), Fr(6, 5), Fr(29, 5)   # 7x, 1.2x, 5.8x
BOOST_RANGE, TARGET, CREATOR_CUT = Fr(7, 100), Fr(12, 100), Fr(12, 100)


def F(z, R):
    """Integral of the boost schedule from 0 to z (shares)."""
    z, R = Fr(z), Fr(R)
    if R == 0:
        return TAIL * z
    if z <= R:
        return FRONT * z - SLIDE * z * z / (2 * R)
    return FRONT * R - SLIDE * R / 2 + TAIL * (z - R)


class Lot:
    __slots__ = ("id", "owner", "shares", "born_block")

    def __init__(self, id, owner, shares, born_block):
        self.id, self.owner, self.shares, self.born_block = id, owner, Fr(shares), born_block


class Pool:
    def __init__(self, creator, x, y, M, block=0, init_shares=None):
        self.x, self.y = Fr(x), Fr(y)
        self.creator, self.creator_compounds = creator, False
        self.lots, self.next_id = [], 1
        self.E = Fr(0); self.L = Fr(0); self.graduated = False; self.creator_on = False
        self.escrow = {}                       # owner -> [coin, quote]
        self.events = []
        self.block = block; self.sealed_block = block
        self._add_lot(creator, Fr(init_shares) if init_shares is not None else Fr(x) * M + Fr(y))

    # ---- bookkeeping ------------------------------------------------------------------
    @property
    def S(self):
        return sum(l.shares for l in self.lots)

    def V(self, M):
        return Fr(M) * self.x + self.y

    def _add_lot(self, owner, shares):
        lot = Lot(self.next_id, owner, shares, self.block)
        self.next_id += 1
        self.lots.append(lot)
        return lot

    def shares_of(self, owner):
        return sum(l.shares for l in self.lots if l.owner == owner)

    def value_of(self, owner, M):
        return self.shares_of(owner) * self.V(M) / self.S

    # ---- trading (no settlement inside a fill) ----------------------------------------------
    def swap(self, dx, dy, M):
        """Pool receives dx coin and dy quote (signed). M is the anchor used for this swap."""
        self.x += Fr(dx); self.y += Fr(dy)
        self.E += Fr(dy) + Fr(M) * Fr(dx)
        assert self.x > 0 and self.y > 0

    def pay_cost(self, quote, coin, M):
        self.x -= Fr(coin); self.y -= Fr(quote)
        self.E -= Fr(quote) + Fr(M) * Fr(coin)

    # ---- checkpoints -------------------------------------------------------------------------
    def touch(self, block, M, src_tvl):
        """First pool interaction in a new block seals the open interval."""
        if block > self.sealed_block:
            self.settle(M, src_tvl)
            self.sealed_block = block
        self.block = block

    def settle(self, M, src_tvl):
        M, src_tvl = Fr(M), Fr(src_tvl)
        E, Lold = self.E, self.L
        Q = max(Fr(0), E - Lold)
        self.L = max(Fr(0), Lold - E)
        self.E = Fr(0)
        V, S = self.V(M), self.S
        if Q > 0:
            if Q >= V:
                self.events.append(("non_distributable", Q))
            else:
                self._distribute(Q, V, S, M, src_tvl)
        if src_tvl > 0:                                            # applies to the next interval
            on = self.V(M) >= TARGET * src_tvl                     # creator cut reversible, LP payouts latch
            if on and not self.graduated:
                self.events.append(("graduated", self.V(M)))
            self.creator_on = on
            self.graduated = self.graduated or on
        return Q

    def _distribute(self, D, V, S, M, src_tvl):
        U = V / S
        R = BOOST_RANGE * src_tvl / U                              # boost range in shares, frozen here
        c = CREATOR_CUT if self.graduated and self.creator_on else Fr(0)
        lp_reward = (1 - c) * D
        U_base = (V - D) / S
        W = F(S, R)
        ahead = Fr(0); alloc = []
        for lot in self.lots:                                      # old snapshot, FIFO order
            w = F(ahead + lot.shares, R) - F(ahead, R)
            ahead += lot.shares
            alloc.append((lot, lp_reward * w / W))
        if not self.graduated:
            for lot, r in alloc:                                   # compound: new tail lots, old-ID order
                if r > 0:
                    self._add_lot(lot.owner, r / U_base)
        else:
            x0, y0 = self.x, self.y
            for lot, r in alloc:
                self._escrow(lot.owner, x0 * r / V, y0 * r / V)
            if c == 0:
                pass
            elif self.creator_compounds:
                self._add_lot(self.creator, c * D / U_base)
            else:
                self._escrow(("creator", self.creator), x0 * c * D / V, y0 * c * D / V)
        self.events.append(("distributed", D))

    def _escrow(self, owner, cx, cy):
        self.x -= cx; self.y -= cy
        e = self.escrow.setdefault(owner, [Fr(0), Fr(0)])
        e[0] += cx; e[1] += cy

    # ---- capital changes (settle first) ------------------------------------------------------
    def deposit(self, owner, dx, dy, M, src_tvl):
        self.settle(M, src_tvl)
        a = min(Fr(dx) / self.x, Fr(dy) / self.y)
        S = self.S
        self.x += a * self.x; self.y += a * self.y
        return self._add_lot(owner, a * S)

    def withdraw(self, lot_id, shares, M, src_tvl):
        self.settle(M, src_tvl)
        lot = next(l for l in self.lots if l.id == lot_id)
        assert lot.born_block < self.block, "same-block deposit and withdraw refused"
        shares = Fr(shares); assert shares <= lot.shares
        f = shares / self.S
        cx, cy = f * self.x, f * self.y
        lot.shares -= shares; self.x -= cx; self.y -= cy
        if lot.shares == 0:
            self.lots.remove(lot)
        return cx, cy

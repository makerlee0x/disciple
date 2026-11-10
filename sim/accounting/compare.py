"""Random histories run through ledger2.py (brute force) and fast.py (accumulators); every lot's principal,
compounded shares and escrowed claims, and the pool's reserves, must match exactly."""
import random, sys
from fractions import Fraction as Fr
import ledger2, fast

def run(seed, steps=30):
    R = random.Random(seed)
    P, Q = ledger2.Pool("cr", 500, 500, 1), fast.Pool("cr", 500, 500, 1)
    cc = R.random() < 0.5
    for p in (P, Q):
        p.creator_compounds = cc
    M = Fr(1); tvl = Fr(R.choice([10**6, 20000, 8000])); blk = 0
    for st in range(steps):
        blk += 1; M = R.choice([Fr(1), Fr(6, 5), Fr(4, 5), Fr(3, 2), Fr(1, 2)])
        for p in (P, Q): p.touch(blk, M, tvl)
        op = R.random()
        live = [l.id for l in P.lots if l.block < blk]
        if op < 0.35:
            dx = Fr(R.randint(1, 60)) * (1 if R.random() < .5 else -1)   # coin into the pool (signed)
            ex = Fr(R.randint(-3, 6), 1000) * abs(dx) * M                  # pool edge vs anchor, can be negative
            dy = -dx * M + ex
            if P.x + dx > 1 and P.y + dy > 1:
                for p in (P, Q): p.swap(dx, dy, M)
        elif op < 0.55:
            amt = Fr(R.randint(1, 300))
            for p in (P, Q): p.deposit(f"u{st}", amt, amt * M * 2, M, tvl)
        elif op < 0.7 and live:
            i = R.choice(live); l = next(l for l in P.lots if l.id == i)
            fs, fb = R.choice([0, Fr(1, 2), 1]), R.choice([0, Fr(1, 3), 1])
            s, b = l.s * fs, l.b * fb
            if s + b > 0 and (s + b) < P.S + P.B:
                for p in (P, Q): p.withdraw(i, s, b, M, tvl)
        elif op < 0.8 and live:
            i = R.choice(live)
            if next(l for l in P.lots if l.id == i).b > 0:
                for p in (P, Q): p.restake(i, M, tvl)
        if P.x <= 0 or P.y <= 0: return None
    for p in (P, Q): p.settle(M, tvl)
    assert P.x == Q.x and P.y == Q.y, "reserves differ"
    assert P.graduated == Q.graduated
    for l in P.lots:
        s, b, claim = Q.lot_view(l.id)
        assert s == l.s and b == l.b, (seed, l.id, "shares differ")
        assert tuple(P.escrow.get(l.id, [0, 0])) == claim, (seed, l.id, "claims differ")
    assert tuple(P.escrow.get("creator", [0, 0])) == tuple(Q.creator_claim)
    return P.graduated

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    res = [run(sd) for sd in range(n)]
    ok = [r for r in res if r is not None]
    print(f"{len(ok)}/{n} histories match exactly ({sum(ok)} reached graduation, {len(ok) - sum(ok)} did not)")

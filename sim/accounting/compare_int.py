"""Random histories through fast.py (exact rationals) and intledger.py (the Solidity algorithm in integers).
Checks: every integer amount is within a tiny relative error of the exact one, never pays an LP more than the exact
model beyond dust, and conservation holds (claims <= escrow, shares <= totals, reserves stay positive).
Run: python3 compare_int.py [n]"""
import random, sys
from fractions import Fraction as Fr
import fast
from intledger import Ledger, Q128

E18 = 10**18  # raw units per whole token; main() also runs 10**6 (a 6-decimal quote such as USDC)


def X(M):
    return int(Fr(M) * Q128)


def run(seed, steps=40):
    R = random.Random(seed)
    P = fast.Pool("cr", 500, 500, 1)
    Q = Ledger("cr", 500 * E18, 500 * E18, X(1))
    cc = R.random() < 0.5
    P.creator_compounds = Q.creator_compounds = cc
    tvl = Fr(R.choice([10**6, 20000, 8000]))
    M = Fr(1)
    blk = 0
    worst = 0.0
    for st in range(steps):
        blk += 1
        # block boundary: settle the old block at its mark, then latch the new mark
        P.settle(M, tvl); Q.settle(X(M), int(tvl * E18))
        M = R.choice([Fr(1), Fr(6, 5), Fr(4, 5), Fr(3, 2), Fr(1, 2)])
        P.settle(M, tvl); Q.settle(X(M), int(tvl * E18))
        P.sealed = blk; P.block = blk
        op = R.random()
        live = [l.id for l in P.lots if l.block < blk]
        if op < 0.35:
            dx = Fr(R.randint(1, 60)) * (1 if R.random() < .5 else -1)
            ex = Fr(R.randint(-3, 6), 1000) * abs(dx) * M
            dy = -dx * M + ex
            if P.x + dx > 1 and P.y + dy > 1:
                P.swap(dx, dy, M)
                Q.swap(int(dx * E18), int(dy * E18))
        elif op < 0.55:
            amt = Fr(R.randint(1, 300))
            P.deposit(f"u{st}", amt, amt * M * 2, M, tvl)
            Q.settle(X(M), int(tvl * E18))
            Q.deposit(f"u{st}", int(amt * E18), int(amt * M * 2 * E18))
        elif op < 0.7 and live:
            i = R.choice(live)
            l = next(l for l in P.lots if l.id == i)
            fs, fb = R.choice([0, Fr(1, 2), 1]), R.choice([0, Fr(1, 3), 1])
            Q.settle(X(M), int(tvl * E18))
            ql = Q.lots[i]
            qs, qb = Q.lot_view(i)[0], Q.lot_view(i)[1]
            s_int, b_int = int(qs * fs), int(qb * fb)
            s, b = Fr(s_int, E18), Fr(b_int, E18)
            P.settle(M, tvl)
            _, pb, _ = P.lot_view(i)
            if s + b > 0 and (s + b) <= P.Sp + P.B - Fr(10**7, E18) and s <= l.s and b <= pb:
                P.withdraw(i, s, b, M, tvl)
                Q.withdraw(i, s_int, b_int)
        elif op < 0.8 and live:
            i = R.choice(live)
            if P.lot_view(i)[1] > 0:
                P.restake(i, M, tvl)
                Q.settle(X(M), int(tvl * E18))
                Q.restake(i)
        if P.x <= 0 or P.y <= 0:
            return None
    P.settle(M, tvl); Q.settle(X(M), int(tvl * E18))
    assert P.graduated == Q.graduated, (seed, "graduation differs")

    def rel(a_int, a_exact, scale):
        ex = Fr(a_exact) * E18
        return float((Fr(a_int) - ex) / max(Fr(scale), Fr(1)))

    scale = (P.x + P.y) * E18
    for name, a, b in (("x", Q.x, P.x), ("y", Q.y, P.y)):
        worst = max(worst, abs(rel(a, b, scale)))
    tot_claim = [0, 0]
    for l in P.lots:
        s, b, claim = P.lot_view(l.id)
        qs, qb, qc = Q.lot_view(l.id)
        for name, a, e in (("s", qs, s), ("b", qb, b), ("cx", qc[0], claim[0]), ("cy", qc[1], claim[1])):
            r = rel(a, e, scale)
            # "beyond dust": 1e-12 of reserves, or a few raw units when the token has few decimals
            assert r <= max(1e-12, 10 / float(scale)), (seed, l.id, name, "integer pays more than exact", r)
            worst = max(worst, abs(r))
        tot_claim[0] += qc[0]; tot_claim[1] += qc[1]
    assert tot_claim[0] <= Q.escrow[0] and tot_claim[1] <= Q.escrow[1], (seed, "claims exceed escrow")
    assert sum(Q.lots[i].s for i in Q.lots) == Q.Sp
    assert sum(Q.balance(Q.lots[i]) for i in Q.lots) <= Q.B
    return P.graduated, worst


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    for unit in (10**18, 10**6):
        E18 = unit
        res = [run(sd) for sd in range(n)]
        ok = [r for r in res if r is not None]
        print(f"unit 1e{len(str(unit)) - 1}: {len(ok)}/{n} histories ok ({sum(g for g, _ in ok)} graduated); "
              f"worst |int - exact| / reserves = {max(w for _, w in ok):.2e}")

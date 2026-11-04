"""GPT ACCOUNTING_SPEC section 8 worked examples A-I, reproduced exactly by ledger.py. Run: python3 test_examples.py"""
from fractions import Fraction as Fr
from ledger import Pool, F

def close(a, b, eps=Fr(1, 10**12)):
    return abs(Fr(a) - Fr(b)) <= eps

BIG = 10**9   # a source TVL that never triggers graduation

def ex_A():
    p = Pool("creator", 500, 500, 1); p.graduated = p.creator_on = True
    for blk, e in ((1, -40), (2, 25), (3, 30)):
        p.swap(e, 0, 1)          # pool receives e coin worth e at M=1 (pure earnings for the test)
        p.touch(blk + 1, 1, 1000)  # pool = 100% of the source: stays graduated, creator on
        if blk == 1: assert p.L == 40
        if blk == 2: assert p.L == 15 and not p.escrow
    cr = p.escrow[("creator", "creator")]; lp = p.escrow["creator"]
    assert close(sum(cr), Fr(18, 10)) and close(sum(lp), Fr(132, 10)) and p.L == 0
    assert close(p.V(1), 1000)
    return "A loss carry: creator 1.80, LPs 13.20, active equity back to 1,000"

def ex_B():
    p = Pool("a", 500, 500, 1)
    p.settle(2, BIG); assert p.V(2) == 1500 and p.L == 0 and not p.escrow
    p.settle(Fr(1, 2), BIG); assert p.V(Fr(1, 2)) == 750 and p.L == 0
    p.swap(10, Fr("-20.20"), 2)  # pool buys 10 coin for 20.20 at M=2: e = -0.20
    assert p.E == Fr("-0.20")
    p.E = 0
    p.swap(-10, Fr("20.20"), 2); assert p.E == Fr("0.20")
    return "B price moves create no earnings; selling 10 coin for 20.20 at M=2 earns exactly 0.20"

def two_lps():
    p = Pool("A", 250, 250, 1, init_shares=100)        # V 500, S 100, U 5
    p.block = 1; p.sealed_block = 1
    p.deposit("B", 250, 250, 1, BIG)                   # +100 shares
    return p

def ex_C():
    assert F(100, 200) == 555 and F(200, 200) == 820
    return "C weights 555/265 of 820 (A 111/164, B 53/164)"

def ex_D():
    p = two_lps()
    p.swap(50, 50, 1)                                  # E = 100, V = 1100
    U = Fr(1100, 200); tvl = 200 * U / Fr(7, 100)      # makes R = 200 shares
    p.touch(2, 1, tvl)
    assert p.S == 220 and p.V(1) / p.S == 5
    assert close(p.shares_of("A") - 100, Fr("13.5365853658537"), Fr(1, 10**10))
    assert close(p.shares_of("B") - 100, Fr("6.46341463414634"), Fr(1, 10**10))
    assert [l.owner for l in p.lots] == ["A", "B", "A", "B"], "reward lots join the tail in old-ID order"
    return "D compounding: A +13.5366 sh, B +6.4634 sh, S 220, NAV/share 5"

def ex_E(compound):
    p = two_lps(); p.graduated = p.creator_on = True; p.creator = "C"; p.creator_compounds = compound
    p.swap(50, 50, 1)
    tvl = 200 * Fr(1100, 200) / Fr(7, 100)
    p.touch(2, 1, tvl)
    a, b = p.escrow["A"], p.escrow["B"]
    assert close(a[0], Fr("29.7804878048780"), Fr(1, 10**10)) and close(b[0], Fr("14.2195121951220"), Fr(1, 10**10))
    if compound:
        assert p.x == 506 and p.y == 506 and p.S == Fr("202.4") and p.V(1) / p.S == 5
        return "E creator compounds: reserves (506, 506), +2.4 shares, NAV/share 5"
    assert p.escrow[("creator", "C")] == [6, 6] and p.x == 500 and p.y == 500
    return "E payout: creator (6, 6), A 29.78 each, B 14.22 each, reserves (500, 500)"

def ex_F():
    p = two_lps(); p.block = 2
    p.withdraw(1, 100, 1, BIG)                         # A leaves after settling (nothing earned)
    p.swap(10, 10, 1); p.touch(3, 1, BIG)
    assert p.shares_of("A") == 0 and p.shares_of("B") > 100 and len(p.lots) == 2 and p.lots[1].owner == "B"
    return "F after A exits, B (now at the front) gets 100% of the next reward"

def ex_G():
    p = Pool("A", 500, 500, 1); p.L = Fr(40); p.x = p.y = Fr(480)   # NAV 960
    p.block = 1; p.sealed_block = 1
    p.deposit("N", 480, 480, 1, BIG)
    assert p.L == 40
    p.swap(25, 0, 1); p.touch(2, 1, BIG)
    assert p.L == 15 and len(p.lots) == 2, "no boosted reward while recovering the loss"
    return "G new capital does not clear the 40 loss; +25 leaves L = 15, nothing distributed"

def ex_H():
    p = Pool("A", 500, 50, 1)
    p.swap(60, -20, 2)                                 # E = 100 at M = 2
    p.touch(1, Fr(8, 100), BIG)                        # V = 560*0.08 + 30 = 74.8 < 100
    assert ("non_distributable", 100) in p.events and len(p.lots) == 1 and not p.escrow
    return "H backing mismatch: Q 100 > V 74.8, nothing distributed, recorded as non-distributable"

def ex_I():
    p = Pool("A", 500, 500, 1, init_shares=1000); p.creator = "C"
    tvl = Fr(1100) / Fr(12, 100)                       # target = 1,100
    p.swap(50, 50, 1); p.touch(1, 1, tvl)
    assert p.graduated and not p.escrow, "first 100 compounds fully; graduation applies next interval"
    p.swap(10, 10, 1); p.touch(2, 1, tvl)
    assert close(sum(p.escrow[("creator", "C")]), Fr("2.40")) and close(sum(p.escrow["A"]), Fr("17.60"))
    return "I graduation is not retroactive: first 100 all to LPs, next 20 pays creator 2.40"

def ex_J():
    p = Pool("A", 500, 500, 1, init_shares=1000); p.creator = "C"
    small, big = Fr(1000), Fr(10**6)                  # pool 100% / 0.1% of the source
    p.swap(50, 50, 1); p.touch(1, 1, small)            # graduates, creator on
    p.swap(10, 10, 1); p.touch(2, 1, big)              # paid at 12%, then the cut turns off
    c1 = sum(p.escrow[("creator", "C")])
    assert close(c1, Fr("2.40")) and p.graduated and not p.creator_on
    p.swap(10, 10, 1); p.touch(3, 1, small)            # no creator cut on this interval; on again after
    assert sum(p.escrow[("creator", "C")]) == c1 and p.creator_on
    p.swap(10, 10, 1); p.touch(4, 1, small)
    assert close(sum(p.escrow[("creator", "C")]), c1 + Fr("2.40"))
    return "J creator cut is reversible: off while below 12% (LP payouts stay on), back on above"

if __name__ == "__main__":
    for f in (ex_A, ex_B, ex_C, ex_D, lambda: ex_E(False), lambda: ex_E(True), ex_F, ex_G, ex_H, ex_I, ex_J):
        print("PASS", f())

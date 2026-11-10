"""Check: with the boost sliding 7x -> 1.2x over the WHOLE principal queue (no kink at a fixed range), exact
per-epoch rewards with FIFO move-up decompose into global accumulators plus two prefix sums, so every operation
is O(log n) with a Fenwick tree. Verified here against brute force over random exits, deposits and epochs.

Per epoch e (one block): rho_e = reward value per unit weight, S_e = principal shares.
  weight of lot i  = F(a+s) - F(a),  F(z) = 7z - 2.9 z^2 / S_e
  reward_i,e       = rho_e * (7 s - 2.9 s^2 / S_e - 5.8 s a_e / S_e)
Accumulators: A1 = sum rho_e, A2 = sum rho_e / S_e, X_j = sum_e s_j,e * rho_e / S_e = c_j + s_j * A2 (lazy).
  sum_e a_i,e rho_e / S_e = sum_{j<i} X_j  -> prefix sums of c_j and s_j (Fenwick), no history needed.
"""
import random
from fractions import Fraction as Fr

def run(seed, epochs=60):
    rnd = random.Random(seed)
    s = []            # live principal shares per lot (id = index)
    c = []            # lazy offsets
    snap = []         # per lot: (A1, A2, PX) at its last change
    acc = []          # efficient accrued value
    brute = []        # brute-force accrued value
    A1 = A2 = Fr(0)

    def PX(i):        # sum_{j<i} X_j  (a Fenwick prefix of c plus A2 * Fenwick prefix of s)
        return sum(c[j] for j in range(i)) + A2 * sum(s[j] for j in range(i))

    def checkpoint(i):  # bring lot i's accrual up to date and re-snapshot (before its size changes)
        a1, a2, px = snap[i]
        acc[i] += 7 * s[i] * (A1 - a1) - Fr(29, 10) * s[i] ** 2 * (A2 - a2) - Fr(58, 10) * s[i] * (PX(i) - px)
        snap[i] = (A1, A2, PX(i))

    def resize(i, new):
        checkpoint(i)
        c[i] -= (new - s[i]) * A2       # keep X_i continuous
        s[i] = new
        snap[i] = (A1, A2, PX(i))

    def add_lot(amount):
        s.append(Fr(0)); c.append(Fr(0)); acc.append(Fr(0)); brute.append(Fr(0)); snap.append((A1, A2, PX(len(s) - 1)))
        resize(len(s) - 1, Fr(amount))

    for _ in range(3):
        add_lot(rnd.randint(1, 1000))
    for e in range(epochs):
        op = rnd.random()
        if op < 0.3:
            add_lot(rnd.randint(1, 1000))
        elif op < 0.5:
            live = [i for i in range(len(s)) if s[i] > 0]
            if len(live) > 1:
                i = rnd.choice(live)
                resize(i, s[i] * rnd.choice([0, Fr(1, 2), Fr(1, 3)]))
        S = sum(s)
        rho = Fr(rnd.randint(1, 100), rnd.randint(1, 50))
        a = Fr(0)
        for i in range(len(s)):        # brute force for this epoch
            brute[i] += rho * ((7 * (a + s[i]) - Fr(29, 10) * (a + s[i]) ** 2 / S) - (7 * a - Fr(29, 10) * a * a / S))
            a += s[i]
        A1 += rho; A2 += rho / S
    for i in range(len(s)):
        checkpoint(i)
    return all(acc[i] == brute[i] for i in range(len(s))), len(s)

if __name__ == "__main__":
    res = [run(sd) for sd in range(40)]
    print(f"{sum(ok for ok, _ in res)}/{len(res)} random histories match brute force exactly "
          f"(up to {max(n for _, n in res)} lots, 60 epochs each, with exits and partial withdrawals)")

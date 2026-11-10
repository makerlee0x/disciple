"""Property checks on the integer engine at frozen external state:
split never beats whole, buy-then-sell round trip never profits, and how far exact-out and exact-in quotes for the same fill differ (both carry pool-favoured slack)."""
import random, sys
from engine import *
random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
split_gain = rt_gain = 0; n = 0; gap = 0.0
for i in range(3000):
    u = int(10 ** random.uniform(10, 28)); v = int(10 ** random.uniform(10, 28))
    T = mulDiv(v, Q128, u); pref = int(T * 10 ** random.uniform(-1, 1))
    kb, ks = slopes(pref, T, markup(premium(4 * 10**16, 30, random.choice([0, 30, 10**6])), 3000))
    X = mulDiv(pref, mulDiv(v, Q128, u), T); m = 10 ** random.uniform(-0.02, 0.02)
    pa, pb = match_bounds(int(X * m * 1.003), int(X * m / 1.003), 1) if random.random() < .7 else (0, 0)
    Q = int(v * 10 ** random.uniform(-8, 0)) + 2; a = random.randint(1, Q - 1)
    try:
        whole = buy_exact_in(u, v, kb, pa, Q)
        q1 = buy_exact_in(u, v, kb, pa, a)
        q2 = buy_exact_in(u - q1, v + a, kb, pa, Q - a)
        if q1 + q2 > whole: split_gain += 1; print("split gain wei", q1 + q2 - whole, "of", whole)
        back = sell_exact_in(u - whole, v + Q, ks, pb, whole)
        if back > Q: rt_gain += 1
        if whole > 10**6: gap = max(gap, (buy_exact_out(u, v, kb, pa, whole) - Q) / Q)
        n += 1
    except OverflowError:
        pass
print(f"{n} cases: split beat whole {split_gain}, round trip profited {rt_gain}, worst exact-out vs exact-in quote gap {gap:.1e}")

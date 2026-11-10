"""Pool-safety and tightness fuzz for the integer engine.
1. Every fill must be pool-favoured vs exact math (out <= exact, in >= exact).
2. The shortfall, valued in quote at the pool's mid, must be at most a few wei plus ~1e-13 of pool value."""
import random, sys
from engine import *
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1; N = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
random.seed(seed)
viol = 0; n = 0; worst = {}
for i in range(N):
    LO = float(sys.argv[3]) if len(sys.argv) > 3 else 6
    u = int(10 ** random.uniform(LO, 30)); v = int(10 ** random.uniform(LO, 30))
    T = mulDiv(v, Q128, u); pref = max(1, int(T * 10 ** random.uniform(-1.3, 1.3)))
    H = premium(4 * 10**16, 30, random.choice([0, 7, 30, 120, 10**6]))
    kb, ks = slopes(pref, T, markup(H, random.choice([500, 3000, 10000])))
    if ks == 0: continue
    mid = D(pref) / D(T) * D(v) / D(u)                # quote wei per coin wei
    pa = pb = 0
    if random.random() < 0.6:
        m = 10 ** random.uniform(-0.05, 0.05)
        X = mulDiv(pref, mulDiv(v, Q128, u), T)
        pa, pb = match_bounds(max(1, int(X * m * 1.003)), max(1, int(X * m / 1.003)), 1)
    frac = 10 ** random.uniform(-12, 0.7)
    jobs = [("buy_in", buy_exact_in, ref_buy_exact_in, kb, pa, int(v * frac) + 1, True, "coin"),
            ("buy_out", buy_exact_out, ref_buy_exact_out, kb, pa, min(u - 1, int(u * min(frac, .97)) + 1), False, "quote"),
            ("sell_in", sell_exact_in, ref_sell_exact_in, ks, pb, int(u * frac) + 1, True, "quote"),
            ("sell_out", sell_exact_out, ref_sell_exact_out, ks, pb, min(v - 1, int(v * min(frac, .97)) + 1), False, "coin")]
    for name, f, rf, k, p, amt, is_out, unit in jobs:
        try:
            got = f(u, v, k, p, amt)
        except OverflowError:
            continue
        ref = rf(u, v, k, p, amt); n += 1
        short = (ref - D(got)) if is_out else (D(got) - ref)
        if short < 0:
            viol += 1; print("VIOLATION", name, u, v, k, p, amt, got, ref)
        sq = short * mid if unit == "coin" else short          # in quote wei
        refq = ref * mid if unit == 'coin' else ref
        excess = max(D(0), sq - 16 * (mid + 1)) / max(2 * D(v), refq)   # beyond 16 wei of each token, vs max(pool value, fill value)
        if excess > worst.get(name, (D(-1),))[0]:
            worst[name] = (excess, u, v, k, p, amt, got, float(ref))
print(f"{n} fills, {viol} trader-favoured")
for k_, w in worst.items():
    print(f"  {k_:9s} worst excess shortfall {float(w[0]):.1e} of max(pool, fill) value   case {w[1:]}")

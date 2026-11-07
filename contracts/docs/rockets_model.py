#!/usr/bin/env python3
"""DISCIPLE Rockets v0 economic model. Pure stdlib. Prints tables.
Fee math: fee=1% of volume; treasury=33% of fee; rocket pool = SHARE of ALL fees, carved from treasury."""
FEE, TREAS, MAXR, DAYS5 = 0.01, 0.33, 777, 5*365
VOLS = [100_000, 1_000_000, 10_000_000]
GROWTH = {"flat": 0.0, "growing": 1.0}   # growing = +100%/yr, compounded daily

def vol(v0, d, g): return v0 * (1+g) ** (d/365)
def pool(v, share): return v*FEE*share
def nrock(d): return min(d, MAXR)          # rocket #d sold on day d (no burns)

def payout(n, start, days, v0, g, share, w=1.0):
    """earnings of rocket n bought on day `start` over `days` days (equal weights)."""
    return sum(pool(vol(v0, d, g), share)*w/nrock(d) for d in range(start, start+days))

def payback(n, price, v0, g, share):
    acc, d = 0, n
    while acc < price:
        acc += pool(vol(v0, d, g), share)/nrock(d); d += 1
        if d-n > 3650: return None
    return d-n

def price_5y(n, v0, g, share, frac=0.5): return frac*payout(n, n, DAYS5, v0, 0.0, share)  # priced on trailing (flat) volume
def annual(n, v0, share): return payout(n, n, 365, v0, 0.0, share)

def fmt(x): return "n/a" if x is None else (f"${x/1e6:.2f}M" if x >= 1e6 else f"${x/1e3:.1f}K" if x >= 1e3 else f"${x:.0f}")
def table(title, hdr, rows):
    print(f"\n### {title}\n"); print("| "+" | ".join(hdr)+" |"); print("|"+"---|"*len(hdr))
    for r in rows: print("| "+" | ".join(str(c) for c in r)+" |")

IDS = [1, 10, 30, 100, 365, 777]
if __name__ == "__main__":
    S = 0.10
    for gname, g in GROWTH.items():
        rows = []
        for v in VOLS:
            for n in IDS:
                p = price_5y(n, v, g, S); a = annual(n, v, S)
                rows.append([fmt(v)+"/d", f"#{n}", fmt(a), fmt(p), fmt(3*a), fmt(10*a), payback(n, p, v, g, S), payback(n, 3*a, v, g, S)])
        table(f"Rocket prices & payback ({gname} volume, 10% share)",
              ["Vol", "Rocket", "Proj. 1y payout", "Price @50% 5y", "Floor 3x", "Start 10x", "Payback d (50%5y)", "Payback d (floor)"], rows)

    for gname, g in GROWTH.items():
        rows = []
        for v in VOLS:
            for label, d0, nd in [("Month 1", 1, 30), ("Year 1", 1, 365), ("Year 2", 366, 365), ("Year 3 (to #777+)", 731, 365)]:
                fees = sum(vol(v, d, g)*FEE*TREAS for d in range(d0, d0+nd))
                kept = sum(vol(v, d, g)*FEE*(TREAS-S) for d in range(d0, d0+nd))
                auc_lo = sum(price_5y(d, v, g, S, 0.5) for d in range(d0, min(d0+nd, MAXR+1)))
                auc_hi = sum(price_5y(d, v, g, S, 1.0) for d in range(d0, min(d0+nd, MAXR+1)))
                lvl = 0.5*auc_lo*0.25   # assume 25% of rockets level to avg 50% of their auction price; 50% to treasury
                rows.append([fmt(v)+"/d", label, fmt(fees), fmt(kept), f"{fmt(auc_lo)}-{fmt(auc_hi)}", fmt(lvl)])
        table(f"Treasury ({gname} volume, 10% share)", ["Vol", "Period", "Gross treasury fees", "Fees kept (after pool)", "Auction sales (50%-100% of 5y)", "Leveling to treasury (est.)"], rows)

    rows = []
    for a in [1.0, 0.8, 0.6, 0.4, 0.25]:
        rows.append([f"{int(a*100)}%", f"{1/a:.2f}x", fmt(annual(100, 1e6, S)/a), payback(100, price_5y(100, 1e6, 0, S)*1, 1e6*1/a, 0, S)])
    table("Energy: active-holder yield, rocket #100 @ $1M/d flat", ["Active share of weight", "Active multiplier", "Active 1y payout", "Payback d (active)"], rows)

    rows = []
    for s in [0.05, 0.10]:
        for n in [1, 30, 365]:
            p = price_5y(n, 1e6, 0, s)
            rows.append([f"{int(s*100)}%", f"#{n}", fmt(pool(1e6, s)*30), fmt(1e6*FEE*(TREAS-s)*30), fmt(p), payback(n, p, 1e6, 0, s)])
    table("Sensitivity 5% vs 10% share @ $1M/d flat", ["Share", "Rocket", "Pool/month", "Treasury kept/month", "Price @50% 5y", "Payback d"], rows)

    rows = [[L, f"{1+0.1*L:.1f}x", f"{100*L*L:.0f}", f"{100*L*L/(0.1*L) if L else 0:.0f}"] for L in range(0, 11)]
    table("Leveling curve: cost(L)=100*L^2 USDG cumulative, weight=1+0.1L (cap 2.0x)", ["Level", "Weight", "Cumulative USDG", "USDG per +1.0x weight"], rows)

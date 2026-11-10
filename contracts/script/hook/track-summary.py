#!/usr/bin/env python3
"""Summary of the live tracker CSV (script/hook/track-live.sh). Usage: python3 script/hook/track-summary.py [csv]"""
import csv, statistics, sys

path = sys.argv[1] if len(sys.argv) > 1 else "../tracker/v02-live.csv"
rows = list(csv.DictReader(open(path)))
if not rows:
    sys.exit(f"no rows in {path}")
f = lambda r, k: float(r[k])
first, last = rows[0], rows[-1]
hours = (f(last, "unix") - f(first, "unix")) / 3600
moves = sum(1 for a, b in zip(rows, rows[1:]) if (a["coin_raw"], a["usdg_raw"]) != (b["coin_raw"], b["usdg_raw"]))
print(f"{len(rows)} rows over {hours:.1f} h ({first['time_utc']} -> {last['time_utc']})")
print(f"pool changed between rows (trades/deposits): {moves}")
print(f"source price: {f(first,'src_price_x1e6')/1e6:.6f} -> {f(last,'src_price_x1e6')/1e6:.6f} USDG")
print(f"pool ${f(last,'pool_usd'):.2f} vs hold ${f(last,'hold_usd'):.2f}: P&L ${f(last,'pnl_usd'):+.2f} ({f(last,'pnl_bp'):+.0f}bp), "
      f"was {f(first,'pnl_bp'):+.0f}bp at start; jar ${f(last,'jar_usd'):.2f}")
print(f"coin share of pool: {f(last,'coin_share_bp')/100:.1f}% (50% = balanced)")
gaps = [abs(f(r, "centre_gap_bp")) for r in rows]
due = sum(r["sample_due"] == "true" for r in rows)
print(f"centre gap |bp|: median {statistics.median(gaps):.0f}, max {max(gaps):.0f}; sample due in {due}/{len(rows)} rows")
print("edge vs Uniswap route (bp, + = we pay more): median / worst / % rows we win")
for k in ["buy1", "sell1", "buy5", "sell5", "buy20", "sell20"]:
    v = [f(r, k + "_bp") for r in rows]
    print(f"  {k:7s} {statistics.median(v):+6.0f} {min(v):+6.0f}  {100*sum(x > 0 for x in v)/len(v):5.1f}%")

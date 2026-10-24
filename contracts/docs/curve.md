# DISCIPLE Bonding Curve (Pump-style CPAMM)

**Status:** `src/libraries/CurveMath.sol` + `src/BondingCurve.sol`  
**Constitution:** §2 / LOCKED #5–#7 (revised 2026-10-15; endpoints + 1M supply rev. 2026-10-23) — single steep CPAMM, $7,777 → $33,333 at exactly `CURVE_SOLD_BPS` sold (72% today, pending)

## Formula

Constant-product virtual reserves \(x\,y = k = x_0 y_0\):

\[
p(s)=\frac{x_0 y_0}{(y_0-s)^2},\qquad
M(s)=p(s)\,S=M_0\Bigl(\frac{y_0}{y_0-s}\Bigr)^2
\]

Fit \(y_0\) so graduation hits \(M_1\) at \(s_{\mathrm{curve}}=0.72\,S\):

\[
r=\frac{M_1}{M_0},\qquad
y_0=s_{\mathrm{curve}}\frac{\sqrt{r}}{\sqrt{r}-1},\qquad
x_0=\frac{M_0}{S}\,y_0
\]

| Parameter | Value |
|-----------|-------|
| \(S\) | 1,000,000 (18 decimals; no burn) |
| \(s_{\mathrm{curve}}\) | 72% of \(S\) |
| \(M_0\) | $7,777 (Launch Pad) |
| \(M_1\) | $33,333 (graduation, Outer Space) |
| \(r\) | \(33{,}333/7{,}777 \approx 4.286\) |

### Trades (round against user)

| Direction | Exact | On-chain |
|-----------|-------|----------|
| Buy (quote → tokens) | \(\mathrm{dy}=y\cdot\mathrm{dx}/(x+\mathrm{dx})\) | floor |
| Sell (tokens → quote) | \(\mathrm{dx}=x\cdot\mathrm{dy}/(y+\mathrm{dy})\) | floor |

### Quote asset pricing

USD targets → quote units via `quotePriceUsd` (USD WAD per 1e18 raw quote units; = USD per full token for 18-dec quotes), read from `QuotePricer` at launch:

```
mcapQuote = mcapUsd * 1e18 / quotePriceUsd
```

The price is never caller-supplied and 0 never means $1: launch reverts if the quote has no registered quote/USDG pool. USDG (6 dec) = `1e30`.

## Worked table (USDG @$1)

| % of supply sold | Market cap | Cum. quote raised (net of fees on curve) |
|------------------|------------|------------------------------------------|
| 0% | $7,777 | $0 |
| 10% | ≈ $9,027 | ≈ $838 |
| 25% | ≈ $11,552 | ≈ $2,370 |
| 50% | ≈ $18,928 | ≈ $6,066 |
| 72% | $33,333 | ≈ **$11,592** |

Gross buys to graduate are higher once the 1% trade fee (+ anti-snipe) is included.

## Invariants kept

- 1% trade fee (33/33/33/1), optional creator tax ≤7%
- Sniper tax 99% → 0% over 7s (per-second: 99/25/3/1/0.3/0.1/0.03%, 0 from 7s) (mode rules v2; escrowed → LockedLP compound bucket at graduation)
- Per-wallet curve cap is configurable (`Launchpad.walletCapBps`), default 0 = no cap
- Optional creator buy ≤0.77% at launch
- Atomic graduate → locked v4 (stub)

## Note vs prior hybrid

The prior Pump-early / raise-late piecewise curve ($12K→$77K) was replaced 2026-10-15 with this single steep CPAMM per updated constitution LOCKED #5–#6, #41.


## Graduation (Uniswap v4)

At graduation (Outer Space, $33,333) the graduating buy atomically:

1. Initializes a v4 pool at the curve-end `sqrtPriceX96` (no price jump).
2. Seeds a **full-range** position with remaining tokens + curve quote (+ fee escrow), owned by **LockedLP**.
3. Registers the pool on **DiscipleHook** (pool fee **0**; hook takes **1%** → FeeRouter 33/33/33/1).

See constitution §2 / LOCKED #5, #17.

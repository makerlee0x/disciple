# DISCIPLE Bonding Curve (Pump-style CPAMM)

**Status:** `src/libraries/CurveMath.sol` + `src/BondingCurve.sol`  
**Constitution:** §2 / LOCKED #5–#7 (revised 2026-10-15) — single steep CPAMM, $7K → $33K at exactly 72% sold

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
| \(S\) | 7B (18 decimals) |
| \(s_{\mathrm{curve}}\) | 72% of \(S\) |
| \(M_0\) | $7,000 (Launch Pad) |
| \(M_1\) | $33,000 (Pearly Gates) |
| \(r\) | \(33/7 \approx 4.714\) |

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
| 0% | $7,000 | $0 |
| 10% | ≈ $8,180 | ≈ $757 |
| 25% | ≈ $10,598 | ≈ $2,153 |
| 50% | ≈ $17,897 | ≈ $5,596 |
| 72% | $33,000 | ≈ **$10,943** |

Gross buys to graduate are higher once the 1% trade fee (+ anti-snipe) is included.

## Invariants kept

- 1% trade fee (33/33/33/1), optional creator tax ≤7%
- Anti-snipe 77.7% → 0% over 7s
- Per-wallet curve cap is configurable (`Launchpad.walletCapBps`), default 0 = no cap
- Optional creator buy ≤0.77% at launch
- Atomic graduate → locked v4 (stub)

## Note vs prior hybrid

The prior Pump-early / raise-late piecewise curve ($12K→$77K) was replaced 2026-10-15 with this single steep CPAMM per updated constitution LOCKED #5–#6, #41.


## Graduation (Uniswap v4)

At Pearly Gates the graduating buy atomically:

1. Initializes a v4 pool at the curve-end `sqrtPriceX96` (no price jump).
2. Seeds a **full-range** position with remaining tokens + curve quote (+ fee escrow), owned by **LockedLP**.
3. Registers the pool on **DiscipleHook** (pool fee **0**; hook takes **1%** → FeeRouter 33/33/33/1).

See constitution §2 / LOCKED #5, #17.

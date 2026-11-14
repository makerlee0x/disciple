# DISCIPLE Bonding Curve (Pump-style CPAMM)

**Status:** `src/libraries/CurveMath.sol` + `src/BondingCurve.sol`  
**Constitution:** §2 / LOCKED #5–#7. Numbers follow the code (`src/libraries/Constants.sol`): $3,333 → $33,333 at
exactly `CURVE_SOLD_BPS = 8424` (84.24%) sold. Docs revised 2026-11-14 to match the code (maker: "docs should follow code").

## Formula

Constant-product part plus a steep tail near graduation:

\[
g=\frac{s}{s_{\mathrm{curve}}},\qquad
M(s)=M_0\Bigl(\frac{y_0}{y_0-s}\Bigr)^2+T\,g^{30},\qquad p(s)=M(s)/S
\]

The constant-product part is fitted to reach $15,000 at \(s_{\mathrm{curve}}\); the tail adds the last \(T\):

\[
r=\frac{15{,}000}{M_0},\qquad
y_0=s_{\mathrm{curve}}\frac{\sqrt{r}}{\sqrt{r}-1},\qquad T=M_1-15{,}000
\]

| Parameter | Value |
|-----------|-------|
| \(S\) | 1,000,000 (18 decimals; no burn) |
| \(s_{\mathrm{curve}}\) | 84.24% of \(S\) (842,400); 15.76% (157,600) seeds the v4 pool |
| \(M_0\) | $3,333 (Launch Pad) |
| \(M_1\) | $33,333 (graduation, Outer Space) |
| \(T\) | $18,333 |

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
| 0% | $3,333 | $0 |
| 10% | ≈ $3,794 | ≈ $356 |
| 25% | ≈ $4,689 | ≈ $988 |
| 50% | ≈ $7,078 | ≈ $2,428 |
| 75% | ≈ $12,456 | ≈ $4,736 |
| 84.24% | $33,333 | ≈ **$6,455** |

Gross buys to graduate are higher once the 1% trade fee (+ anti-snipe) is included.

## Invariants kept

- 1% trade fee (33/33/33/1), optional creator tax ≤7%
- Sniper tax 99% → 0% over 7s (per-second: 99/25/3/1/0.3/0.1/0.03%, 0 from 7s) (mode rules v2; escrowed → LockedLP compound bucket at graduation)
- Wallet cap per mode (see mode-rules-v2.md). It is a **buy cap** on the wallet's net curve position: plain token
  transfers between wallets are not tracked outside Easy (maker 2026-11-14: no transfer hook)
- Optional creator buy ≤7.77% at launch (TRENCH default; Easy 1.2%, Hard 3.33%)
- Atomic graduate → locked v4 (stub)

## Note vs prior hybrid

The prior Pump-early / raise-late piecewise curve ($12K→$77K) was replaced 2026-10-15 with this single steep CPAMM per updated constitution LOCKED #5–#6, #41.


## Graduation (Uniswap v4)

At graduation (Outer Space, $33,333) the graduating buy atomically:

1. Initializes a v4 pool at the curve-end `sqrtPriceX96` (no price jump).
2. Seeds a **full-range** position with remaining tokens + curve quote (+ fee escrow), owned by **LockedLP**.
3. Registers the pool on **DiscipleHook** (pool fee **0**; hook takes **1%** → FeeRouter 33/33/33/1).

See constitution §2 / LOCKED #5, #17.

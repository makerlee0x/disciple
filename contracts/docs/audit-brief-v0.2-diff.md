# Disciple hook v0.2: review brief (diff since the v0.1 audit)

**Repo:** https://github.com/makerlee0x/disciple, branch `claude/project-thread-c2uvpb` (PR #265).
**Reviewed before:** v0.1 at 958a18d, fixes at **b40b914** (nothing above Medium; brief `AUDIT_BRIEF_v0.1.md`).
**This review:** the source changes from **b40b914 to the branch head**, only in `contracts/src/hook/` (two commits:
5f74d49 flat curve, 3134db0 read-only quote + gas). Everything else in the hook is as you reviewed it.
**Ask:** the same as before (loss of funds, solvency, price/fee/tip manipulation, anything that can make a swap or a
price delivery revert, divergence from the intended behaviour), focused on the four changes below. Please say clearly
if you find nothing above Low.

```
git diff b40b914..HEAD -- contracts/src/hook
```
4 files: `libraries/DiscipleFlatMath.sol` (new, ~390 lines), `DiscipleHook.sol`, `DiscipleBooks.sol`,
`libraries/DiscipleLedger.sol`. Tests: `FOUNDRY_PROFILE=solar forge test --isolate` (1088 pass).

## Why v0.2
The live v0.1 pool was priced off a near-constant-product curve around the centre. One $2 buy on a $200 pool
leaned the inventory 4% and made the next buy 6.8% worse than the source, so routers stopped using it. v0.2 makes
the price nearly flat near the centre. It keeps the v0.1 centre/step rule, the match caps against the live source
(ask >= source ask - 1bp, bid <= source bid + 1bp), the fee, the tip jar and the ledger.

## 1. Flat-centre curve (`DiscipleFlatMath`, called through `BK.fill`): main new risk
- Marginal price as a function of r = v/u (quote per coin reserves), T = seed ratio (X128), k = kBuy or kSell (WAD):
  - in the band |ln(r/T)| <= W = 1.0: price = k·T·(r/T)^λ with λ = 0.05 (nearly flat)
  - below the band: constant product with kLow = k·e^{Wβ}; above it: kHigh = k·e^{−Wβ} (β = 1 − λ), so the pieces
    meet and a side never runs dry.
- Inside the band, k·u^β + (v/T)^β stays constant, which gives every fill a closed form (`_segBuyIn/_segBuyOut/
  _segSellIn/_segSellOut`). Fills that cross a band edge are split at the edge (`_quoteToTop`, `_coinToBottom`).
  Constant-product segments reuse the audited `DiscipleSwapMath` fills with p = 0.
- Match boundary p (same meaning as v0.1): a buy never pays below p and a sell never gets above it. Fills run on
  the line v + p·u = const until the curve reaches p (`_linePoint`, `_boundRoot`).
- Rounding is meant to favour the pool: each pow (`_pow`, Solady lnWad/expWad) is moved against the trader by a
  1e-12 relative margin plus 2 wei, and results are taken as differences of remaining reserves.
- Constants `EW`/`EWB` are expWad(W) and expWad(W·β) precomputed (checked by `test_flat_expConstants`).

**Please check most closely:**
- Any input where a fill pays out more than the exact curve (exact-in), or charges less (exact-out), including
  across the band edges, at the match boundary, at tiny amounts (1 wei to 1e6) and at huge reserves (1e30+).
- Whether a buy-then-sell round trip, or splitting one trade into many (same block, no centre change), can ever
  profit or drain a side. Fuzz: `testFuzz_flat_splitNeverBeatsWhole`, `testFuzz_flat_roundTripLoses`,
  `testFuzz_flat_exactOutCoversExactIn` (20,000 runs pass); 120 vectors against a float sim (`test_flat_vectorsMatchSim`).
- Reverts that block a swap: lnWad/expWad domain (x <= 0, overflow), `TradeTooLarge`, mulDiv overflow, and region
  selection (`_region`) when r sits exactly on an edge.
- Cross-chain pools now use the same flat fill (with their own slopes and band from `BK.crossQuote`).

## 2. `quoteView(id, zeroForOne, amountSpecified)`: plain view for routers
- Returns (amountIn, amountOut), meant to equal `quote()` (still there, always reverts) and the swap sent in the same
  block against the same state.
- It works out the swap's first touch without writing anything: the anchor step if `sampleBlock < block.number`, and on
  the first swap of a block the jar skim the settle takes out of the reserves (`BK.skimPreview` →
  `LG.skimPreview`, a copy of the skim arithmetic in `LG.settle`). Cross chain: entering local mode re-centres T.
  TVL readings, graduation and the creator cut don't move the fill, so they're left out.
- Please check: any state where quoteView ≠ swap (a router would then mis-route or a swap would hit slippage
  limits), and anything in it that can revert where the swap would not. Tests: `test/hook/QuoteView.t.sol`
  (states incl. sample-then-swap in one block, skim on first touch, local-mode entry; fuzz with samples).

## 3. Gas and storage changes
- Reentrancy flag moved to **transient storage** (`LOCK_SLOT`, `_enter/_exit`, tload/tstore), same modifier semantics.
- `LG.Book.dx/dy` (net flow of the open interval) are now **int128** in one slot, written with `SafeCast.toInt128`
  (`LG.swap`). Please check whether any honest sequence can overflow them (they reset every settle) and so revert swaps.
- Pool struct: `sampleBlock`/`sampleAt` moved next to `obsAt`/`settledBlock` (one slot). Off-chain keeper offsets
  updated to match.
- `TIP_OVERHEAD` 63k → 58k: the lock no longer sits in the unmeasured part of `sample()`. A batch of 8 samples in one
  tx is paid ≤ gas + 20% (`test_audit_batchedSamplesUnderMarkup`); a single repeat sample about 117%.
- Cross-chain slopes/band moved into `BK.crossQuote` (same maths, for bytecode size). Hook 22,171 B, BK 22,329 B.

## 4. Unchanged and closed (please don't re-raise)
Everything in the v0.1 brief's "Deliberate design decisions" and "Closed items" still holds (permissionless pools,
no TWAP, immutable params, the one-step residual, D-02, R-01, the 2-block source push attack).
Accepted for v0.2: small pools get almost no router share for orders under ~$100 (gas and depth, not a bug).

## Format
For each finding: severity, the function(s), a concrete reproduction (ideally a Foundry test using
`test/hook/Disciple.t.sol`'s setup), the loss in numbers, and a minimal fix.

---

## Fixes after the v0.2 review (muse, 2026-11-08)
Report: `/mnt/project-files/disciple-review/AUDIT_PR265_v0.2_muse.md` (1 High, 1 Medium, 6 Low, 3 Info).

| Finding | Outcome |
|---|---|
| H-1 `_rho` floors to 0 on low-price pools (all band sells revert, buys pay 0) | Fixed: ratio taken in X128 first, then scaled (`_rho`). `test_flat_lowPricePoolTrades`, `testFuzz_flat_lowPrice` (both fail on the old code). |
| M-1 quoteView ignores the graduated payout taken in the first-touch settle | Fixed: `BK.settlePreview` / `LG.settlePreview` model skim + LP escrow + creator claim, with the creator-cut judgement after the new TVL reading (`_judgeAfter`). `test_quoteView_graduatedCreatorPaid/Compounds` (fail on the old preview). Residual: a v4 source's TVL reading is taken as not new in the view, so on the one touch where its depth pass ends AND that flips the creator cut, the view can differ slightly. |
| L-1 split beats whole on low-price pools | Fixed by the H-1 change (dominant term). |
| L-2 `_distribute` raw products overflow above ~5e37 raw pool value | Not changed: unreachable for real token supplies (largest ~1e30 raw); changing audited payout rounding is the larger risk. |
| L-3 first (cold) tipped sample pays ~91% of cost | Accepted: one-time per keeper per token; repeats ~119%, batch of 8 ~119%. |
| L-4 int128 `dx/dy` overflow near int128.max | Not changed: needs > 1.7e38 raw tokens in one interval. |
| L-5 cross-chain withdraw scaling overflow | Fixed: `_scaleFlow` (512-bit, same rounding toward zero). |
| L-6 quoteView unknown pool → NotLive | Fixed: uses `_live` (UnknownPool / NotLive like quote()). `test_quoteView_unknownPool`. |
| I-1 jar cap valued at the unstepped anchor in quoteView | Fixed: `_jarRoom`/`_weiToQuote` take the anchor explicitly; the view passes the stepped one. |
| I-2 exact-out quantization ≤ ~1e-7 | Accepted (inherent). |
| I-3 stale keeper comment | Fixed. |

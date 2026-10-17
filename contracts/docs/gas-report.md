# Swap gas report (feat/modes-gas)

Benchmark: `forge test --mc GasBench --isolate -vv` (test/gas/GasBench.t.sol). Every measured call is its own tx (cold access accurate). Gas = `lastCallGas().gasTotalUsed` = execution gas, **excludes the 21k intrinsic + calldata**; the $ columns add 21k. Price: 0.0207 gwei, ETH $2,412 (1¢ ≈ 200k gas). BEFORE = feat/usdg-router 4568270a, AFTER = this branch. cold = trader's first trade, warm = second.

| trade | BEFORE gas | AFTER gas | Δ | BEFORE $ | AFTER $ |
|---|---:|---:|---:|---:|---:|
| curve.direct.buy.cold | 248,278 | 212,434 | -35,844 (-14%) | 1.34¢ | 1.17¢ |
| curve.direct.buy.warm | 214,078 | 178,234 | -35,844 (-17%) | 1.17¢ | 0.99¢ |
| curve.direct.sell.warm | 208,711 | 179,051 | -29,660 (-14%) | 1.15¢ | 1.00¢ |
| curve.usdg1.buy.cold | 331,970 | 235,774 | -96,196 (-29%) | 1.76¢ | 1.28¢ |
| curve.usdg1.buy.warm | 297,770 | 201,574 | -96,196 (-32%) | 1.59¢ | 1.11¢ |
| curve.usdg1.sell.warm | 282,638 | 201,506 | -81,132 (-29%) | 1.52¢ | 1.11¢ |
| curve.usdg2.buy.cold | 432,325 | 336,182 | -96,143 (-22%) | 2.26¢ | 1.78¢ |
| curve.usdg2.buy.warm | 375,619 | 279,476 | -96,143 (-26%) | 1.98¢ | 1.50¢ |
| curve.usdg2.sell.warm | 402,406 | 321,289 | -81,117 (-20%) | 2.11¢ | 1.71¢ |
| v4.direct.buy.cold | 404,289 | 344,840 | -59,449 (-15%) | 2.12¢ | 1.83¢ |
| v4.direct.buy.warm | 330,764 | 254,082 | -76,682 (-23%) | 1.76¢ | 1.37¢ |
| v4.direct.sell.warm | 310,463 | 254,074 | -56,389 (-18%) | 1.65¢ | 1.37¢ |
| v4.usdg1.buy.cold | 368,022 | 292,143 | -75,879 (-21%) | 1.94¢ | 1.56¢ |
| v4.usdg1.buy.warm | 350,854 | 275,011 | -75,843 (-22%) | 1.86¢ | 1.48¢ |
| v4.usdg1.sell.warm | 330,348 | 274,702 | -55,646 (-17%) | 1.75¢ | 1.48¢ |
| v4.usdg2.buy.cold | 491,099 | 432,453 | -58,646 (-12%) | 2.56¢ | 2.26¢ |
| v4.usdg2.buy.warm | 395,072 | 319,193 | -75,879 (-19%) | 2.08¢ | 1.70¢ |
| v4.usdg2.sell.warm | 398,467 | 342,881 | -55,586 (-14%) | 2.09¢ | 1.82¢ |
## Mode overhead (AFTER, USDG-quoted coin, warm unless noted)

| trade | TRENCH | PVP | PVE |
|---|---:|---:|---:|
| direct buy (cold, first trade) | 212,422 | 212,978 (+556) | 251,029 (+38,607) |
| direct buy | 178,222 | 178,778 (+556) | 191,710 (+13,488) |
| direct sell (no tax) | 179,051 | 179,039 (≈0) | 192,663 (+13,612) |
| USDG 1-hop buy | 201,562 | 202,130 (+568) | 215,050 (+13,488) |
| USDG 1-hop sell | 201,506 | 201,506 (0) | 215,113 (+13,607) |

PVE cold buy includes the one-time LoginGate read + cache, cost-basis and totalNet slots. A taxed PVE sell additionally writes the accumulator (~+5-25k).

## Block-start anchor guard (follow-up), exact cost

`forge test --isolate --match-test test_bench_v4` (each call is its own tx). The baseline is commit 14bf72a2, the
same bench file:

| v4 swap (USDG-quoted coin, warm trader) | before anchor | with anchor | Δ |
|---|---:|---:|---:|
| non-compounding buy, later swap in the same block | 237,682 | 238,631 | **+949** |
| non-compounding sell, later swap in the same block | 237,616 | 238,565 | **+949** |
| non-compounding buy, pool's FIRST swap of the block | 237,618 | 241,520 | **+3,902** |
| compounding buy, same block | 251,298 | 254,050 | +2,752 |
| compounding buy, first in block | 251,366 | 257,051 | +5,685 |

- The hook's `beforeSwap` reads the packed `{tier, anchorBlock, anchorSqrt}` slot (cold SLOAD). That read warms the
  slot for `afterSwap`'s altitude-tier read, which used to be the cold one, so a non-first swap pays +949 net.
- The first swap on a pool in each block also rewrites that slot (SSTORE nonzero→nonzero, ~2.9k). Only one swap per
  pool per block pays it.
- Compound-ready swaps also pay one extra `getSlot0` plus a warm anchor read (~1.8k) to choose the reference price.
- The rows in the main table above (v4.*) are the current numbers and include the anchor. The bench swaps are
  compound-ready, and `.cold` / first-call rows are first-in-block.

## DISCIPLE audit round 2 (exact, `--isolate`)

PREV = #75 @ c003aaa (the numbers above), NOW = this branch after HIGH-1, M1, M2, L1–L7, GAS. Same bench file
(round-2 only adds a 61 s warp after graduation so the EMA reference is ready).

| trade | PREV | NOW | Δ |
|---|---:|---:|---:|
| curve.direct.buy.cold | 212,434 | 212,584 | +150 |
| curve.direct.buy.warm | 178,234 | 178,384 | +150 |
| curve.direct.sell.warm | 179,051 | 179,218 | +167 |
| curve.usdg1.buy.cold | 235,774 | 236,354 | +580 |
| curve.usdg1.buy.warm | 201,574 | 202,154 | +580 |
| curve.usdg1.sell.warm | 201,506 | 199,910 | -1,596 |
| curve.usdg2.buy.cold | 336,182 | 336,784 | +602 |
| curve.usdg2.buy.warm | 279,476 | 280,078 | +602 |
| curve.usdg2.sell.warm | 321,289 | 319,715 | -1,574 |
| v4.direct.buy.cold | 344,840 | 348,812 | +3,972 |
| v4.direct.buy.warm | 254,082 | 256,862 | +2,780 |
| v4.direct.sell.warm | 254,074 | 256,615 | +2,541 |
| v4.direct.buy.firstInBlock | 257,051 | 260,948 | +3,897 |
| v4.direct.buy.sameBlock | 254,050 | 256,958 | +2,908 |
| v4.usdg1.buy.cold | 292,143 | 295,067 | +2,924 |
| v4.usdg1.buy.warm | 275,011 | 277,935 | +2,924 |
| v4.usdg1.sell.warm | 274,702 | 277,365 | +2,663 |
| v4.usdg2.buy.cold | 432,453 | 436,441 | +3,988 |
| v4.usdg2.buy.warm | 319,193 | 321,989 | +2,796 |
| v4.usdg2.sell.warm | 342,881 | 345,416 | +2,535 |
| v4nc.direct.buy.firstInBlock | 241,520 | 242,944 | +1,424 |
| v4nc.direct.buy.sameBlock | 238,631 | 239,086 | +455 |
| v4nc.direct.sell.sameBlock | 238,565 | 238,786 | +221 |
| trench.direct.buy.cold | 212,422 | 212,572 | +150 |
| trench.direct.buy.warm | 178,222 | 178,372 | +150 |
| trench.direct.sell.warm | 179,051 | 179,218 | +167 |
| trench.usdg1.buy.warm | 201,562 | 202,142 | +580 |
| trench.usdg1.sell.warm | 201,506 | 199,910 | -1,596 |
| pvp.direct.buy.cold | 212,978 | 213,128 | +150 |
| pvp.direct.buy.warm | 178,778 | 178,928 | +150 |
| pvp.direct.sell.warm | 179,039 | 179,206 | +167 |
| pvp.usdg1.buy.warm | 202,130 | 202,710 | +580 |
| pvp.usdg1.sell.warm | 201,506 | 199,910 | -1,596 |
| pve.direct.buy.cold | 251,029 | 253,445 | +2,416 |
| pve.direct.buy.warm | 191,710 | 193,944 | +2,234 |
| pve.direct.sell.warm | 192,663 | 195,131 | +2,468 |
| pve.usdg1.buy.warm | 215,050 | 217,734 | +2,684 |
| pve.usdg1.sell.warm | 215,113 | 215,846 | +733 |

Where the deltas come from:
- **v4 compounding swaps +2.5k–4.0k (HIGH-1/L7):** the EMA update on the first swap of a block (same single SSTORE,
  more arithmetic), `TickMath.getSqrtPriceAtTick` for the anchor and the EMA reference, and the extra deviation check
  in LockedLP. Non-compounding v4 swaps (`v4nc`) pay only **+221 to +455** in later swaps of a block and **+1,424**
  on the pool's first swap of a block.
- **Curve USDG routes (L3 + GAS):** the prepaid balance-delta check adds one `balanceOf`. The cached `trustedRouter`
  immutable removes the external `Launchpad.isTrustedRouter` call. Net: buys **+580/+602**, sells **−1,596/−1,574**.
- **Curve direct +150/+167:** `rewardsHeld` bookkeeping/branch layout from the L6 and size refactor.
- **PVE +0.7k–2.7k (M1):** the PVE token's `_update` reads its `{pveCurve, pveLive}` slot (cold) on the curve's
  token transfer. TRENCH/PVP tokens skip it with one immutable check, so they match the plain curve rows.
- Contract sizes: CurveDeployer runtime 24,378 B (EIP-170 margin 198 B), BondingCurve runtime 22,548 B.

## G-1: hook Trade emits sqrtPriceAfter instead of mcapAfterUsd (exact, `--isolate`)

`forge test --mc '^GasBench$' --mt test_bench_v4 --isolate -vv`. BEFORE = 60a0525e, AFTER = this commit. The bench now
wires `hook.setPricer(pricer)` in `setUp` like `Deploy.s.sol` does. Before this change it did not, so the old v4 rows
never paid the per-swap QuotePricer call. "BEFORE (wired)" is the production-shaped baseline. "BEFORE (old bench)" is
60a0525e with the bench file unchanged (no hook pricer).

| trade | BEFORE (wired) | AFTER | Δ | BEFORE (old bench) | Δ |
|---|---:|---:|---:|---:|---:|
| v4.direct.buy.cold | 283,081 | 277,352 | -5,729 | 279,466 | -2,114 |
| v4.direct.buy.warm | 261,011 | 255,282 | -5,729 | 257,396 | -2,114 |
| v4.direct.sell.warm | 260,730 | 254,995 | -5,735 | 257,115 | -2,120 |
| v4.direct.buy.firstInBlock | 265,178 | 259,449 | -5,729 | 261,563 | -2,114 |
| v4.direct.buy.sameBlock | 261,107 | 255,378 | -5,729 | 257,492 | -2,114 |
| v4.usdg1.buy.cold | 299,260 | 293,531 | -5,729 | 295,645 | -2,114 |
| v4.usdg1.buy.warm | 282,128 | 276,399 | -5,729 | 278,513 | -2,114 |
| v4.usdg1.sell.warm | 281,524 | 275,789 | -5,735 | 277,909 | -2,120 |
| v4.usdg2.buy.cold | 373,631 | 342,519 | -31,112 | 344,633 | -2,114 |
| v4.usdg2.buy.warm | 351,565 | 320,453 | -31,112 | 322,567 | -2,114 |
| v4.usdg2.sell.warm | 374,958 | 343,840 | -31,118 | 345,960 | -2,120 |
| v4nc.direct.buy.firstInBlock | 246,845 | 241,116 | -5,729 | 243,230 | -2,114 |
| v4nc.direct.buy.sameBlock | 242,906 | 237,177 | -5,729 | 239,291 | -2,114 |
| v4nc.direct.sell.sameBlock | 242,572 | 236,837 | -5,735 | 238,957 | -2,120 |

- Every post-grad swap used to call `QuotePricer.quotePriceUsd(quote)` only to fill `Trade.mcapAfterUsd`. For a
  STRATEGY-quoted coin (`usdg2`, TWAP binary search) that cost **-31,112**. For a USDG-quoted coin (the pricer's
  reference quote, short-circuits) it cost **-5,729**. Without a pricer wired, the hook still paid the cold
  `pricer()` SLOAD plus the zero-address branch, which is **-2,114**.
- AFTER no longer depends on pricer wiring: the swap path never reads `pricer`.
- Altitude/tier still needs a USD mcap. It now uses the launch-time `quotePriceUsd` that `afterSwap` already loads with
  `metaOf` (no extra SLOAD or CALL), so the tier ladder is priced at the coin's launch-time quote/USD instead of the
  live TWAP. For USDG-quoted coins the two are identical (1e18).

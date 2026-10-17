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

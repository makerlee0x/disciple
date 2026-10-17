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
| v4.direct.buy.cold | 404,289 | 341,955 | -62,334 (-15%) | 2.12¢ | 1.81¢ |
| v4.direct.buy.warm | 330,764 | 251,330 | -79,434 (-24%) | 1.76¢ | 1.36¢ |
| v4.direct.sell.warm | 310,463 | 251,317 | -59,146 (-19%) | 1.65¢ | 1.36¢ |
| v4.usdg1.buy.cold | 368,022 | 289,391 | -78,631 (-21%) | 1.94¢ | 1.55¢ |
| v4.usdg1.buy.warm | 350,854 | 272,223 | -78,631 (-22%) | 1.86¢ | 1.46¢ |
| v4.usdg1.sell.warm | 330,348 | 272,005 | -58,343 (-18%) | 1.75¢ | 1.46¢ |
| v4.usdg2.buy.cold | 491,099 | 429,568 | -61,531 (-13%) | 2.56¢ | 2.25¢ |
| v4.usdg2.buy.warm | 395,072 | 316,441 | -78,631 (-20%) | 2.08¢ | 1.68¢ |
| v4.usdg2.sell.warm | 398,467 | 340,124 | -58,343 (-15%) | 2.09¢ | 1.80¢ |
## Mode overhead (AFTER, USDG-quoted coin, warm unless noted)

| trade | TRENCH | PVP | PVE |
|---|---:|---:|---:|
| direct buy (cold, first trade) | 212,422 | 212,978 (+556) | 251,029 (+38,607) |
| direct buy | 178,222 | 178,778 (+556) | 191,710 (+13,488) |
| direct sell (no tax) | 179,051 | 179,039 (≈0) | 192,663 (+13,612) |
| USDG 1-hop buy | 201,562 | 202,130 (+568) | 215,050 (+13,488) |
| USDG 1-hop sell | 201,506 | 201,506 (0) | 215,113 (+13,607) |

PVE cold buy includes the one-time LoginGate read + cache, cost-basis and totalNet slots. A taxed PVE sell additionally writes the accumulator (~+5-25k).

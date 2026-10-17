---
title: Altitude and tiers
slug: /docs/game/tiers
section: Game
---
# Altitude and tiers

A rocket's **altitude** is its market cap. As it climbs, it passes through 18 tiers, from Launch Pad to Seventh Heaven. Each tier has its own sky.

Graduation happens at **Outer Space**, $33K.

| # | Tier | Market cap from | Up to |
|---|---|---|---|
| 1 | **Launch Pad** | $7K | $12K |
| 2 | **Ozone** | $12K | $18K |
| 3 | **Stratosphere** | $18K | $25K |
| 4 | **Kármán Line** | $25K | $33K |
| 5 | **Outer Space** · graduation | $33K | $55K |
| 6 | **Firmament** | $55K | $100K |
| 7 | **Morning Stars** | $100K | $333K |
| 8 | **Heavenly Host** | $333K | $777K |
| 9 | **The Moon** | $777K | $1.2M |
| 10 | **Uranus** | $1.2M | $3.3M |
| 11 | **Limbo** | $3.3M | $7.7M |
| 12 | **Gates of Heaven** | $7.7M | $33M |
| 13 | **Throne Room** | $33M | $77M |
| 14 | **Cherubim** | $77M | $120M |
| 15 | **Seraphim** | $120M | $777M |
| 16 | **Aether** | $777M | $1.2B |
| 17 | **Empyrean** | $1.2B | $3.3B |
| 18 | **Seventh Heaven** | $3.3B | $7.77B |

Each tier starts at its "from" value and runs up to, not including, the next tier. Seventh Heaven is the top.

## How altitude is measured

- **Spot market cap:** price after the latest trade × 7B supply, in dollars.
- On the curve, the dollar value uses the base's price fixed at launch.
- Every trade updates the altitude on-chain. A tier change is recorded on-chain too, in either direction.

Altitude is a game and display signal. A single large trade can cross a tier and the next can drop it back.

## Tiers are display only

Tiers don't change fees, prices or access. They mark how high a rocket has flown.

> [CONFIRM: FLOW — the constitution (§9) and Constants.sol still use the old tier names; FLOW is renaming them. The names here match the app (`tiers.ts`) and LEXICON.]

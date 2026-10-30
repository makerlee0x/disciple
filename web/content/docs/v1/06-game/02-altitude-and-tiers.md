---
title: Altitude and tiers
slug: /docs/game/tiers
section: Game
---
# Altitude and tiers

A rocket's **altitude** is its market cap. As it climbs, it passes through 18 tiers, from Launch Pad to Seventh Heaven. Each tier has its own sky.

Ascension happens at **Outer Space**, $33,333.

| Tier | Market cap from | Up to |
|---|---|---|
| **Launch Pad** | $3,333 | $12K |
| **Ozone** | $12K | $18K |
| **Stratosphere** | $18K | $25K |
| **Kármán Line** | $25K | $33,333 |
| **Outer Space** · ascension | $33,333 | $55K |
| **Firmament** | $55K | $100K |
| **Morning Stars** | $100K | $333K |
| **Heavenly Host** | $333K | $777K |
| **The Moon** | $777K | $1.2M |
| **Uranus** | $1.2M | $3.3M |
| **Limbo** | $3.3M | $7.7M |
| **Gates of Heaven** | $7.7M | $33M |
| **Throne Room** | $33M | $77M |
| **Cherubim** | $77M | $120M |
| **Seraphim** | $120M | $777M |
| **Aether** | $777M | $1.2B |
| **Empyrean** | $1.2B | $3.3B |
| **Seventh Heaven** | $3.3B | $7.77B |

Each tier starts at its "from" value and runs up to, not including, the next tier. Seventh Heaven is the top.

## How altitude is measured

- **Spot market cap:** price after the latest trade × 1M supply, in dollars.
- On the curve, the dollar value uses the base's price fixed at launch.
- Every trade updates the altitude on-chain. A tier change is recorded on-chain too, in either direction.

Altitude is a game and display signal. A single large trade can cross a tier and the next can drop it back.

## Tiers are display only

Tiers don't change fees, prices or access. They mark how high a rocket has flown.

> [CONFIRM: FLOW — the constitution (§9) and Constants.sol still use the old tier names; FLOW is renaming them. The names here match the app (`tiers.ts`) and LEXICON.]

---
title: Altitude and tiers
slug: /docs/game/tiers
section: Game
---
# Altitude and tiers

**Altitude** is how high a rocket's value has climbed. The game shows that climb as 18 named tiers, from Launch Pad to Seventh Heaven. Each tier has its own sky.

The rocket reaches orbit at **Outer Space**, which starts at $33,333. Reaching orbit means the path its price follows at the start is finished, and the rocket moves to the open market on Uniswap.

| Tier | Value from | Up to |
|---|---|---|
| **Launch Pad** | $3,333 | $12K |
| **Ozone** | $12K | $18K |
| **Stratosphere** | $18K | $25K |
| **Kármán Line** | $25K | $33,333 |
| **Outer Space** · reaches orbit | $33,333 | $55K |
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

- **Value:** the price after the latest trade, times that rocket's supply of 1 million, in dollars.
- Before the rocket reaches orbit, that dollar value uses the base coin's price from launch.
- Every trade updates the altitude. A tier change is recorded too, in either direction.

Altitude is a game display. A single large trade can cross a tier, and the next trade can drop it back.

## Tiers are display only

Tiers don't change fees, prices or who can trade. They mark how high a rocket's value has climbed.

> [CONFIRM: FLOW — the constitution (§9) and Constants.sol still use the old tier names; FLOW is renaming them. The names here match the app (`tiers.ts`) and LEXICON.]

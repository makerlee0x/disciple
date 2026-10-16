# Ammo tiers

Ammo (buy) and bomb (sell) preset sizes scale with the rocket's market-cap tier. $100 is a whale shot on a $20K
coin and noise on a $20M coin, so each preset should be a similar % impact at every tier.

**Single source of truth:** `web/lib/flight/ammoTiers.ts` (`AMMO_TIERS`). `FlightCanvas` hands the table to the
engine as `window.__AMMO_TIERS` before `public/flight/engine.js` loads. The engine re-labels its six presets from
it, and the ammo bar (`TradeBridge`) shows whatever the engine reports (`disciple:ammo` event). No contract
addresses are involved.

| Tier | Rocket mcap | FEATHER | EMBER | FLARE | COMET | ARCHANGEL | GLORY |
|---|---|---|---|---|---|---|---|
| SPARK | < $50K | $0.20 | $0.50 | $1 | $2 | $5 | $20 |
| KINDLE | $50K – $250K | $0.50 | $2 | $5 | $10 | $25 | $100 |
| BLAZE | $250K – $1M | $2 | $5 | $20 | $50 | $100 | $500 |
| INFERNO | $1M – $5M | $5 | $25 | $100 | $250 | $500 | $2.5K |
| NOVA | $5M – $20M | $25 | $100 | $500 | $1K | $2.5K | $10K |
| SUPERNOVA | ≥ $20M | $100 | $500 | $2K | $5K | $10K | $50K |

* Each tier is ≈4–5× the previous one (tier mid-points are ≈4.5× apart), so presets keep roughly the same % of mcap.
* SPARK floors at the network minimum shot (≈$0.20 on RH: gas ≤ 5% of the shot), so low-mcap rockets stay
  playable on small budgets.
* Bomb *tiers* (grenade → atom) are chosen by % price impact (`BOMB_PCT`), so they need no scaling; sells simply use
  the same scaled presets.

## Behaviour

* On first price, the player's presets start at the rocket's current tier.
* The rocket's tier changes only after the mcap is 5% past a boundary (hysteresis), so prices hovering at a line
  don't flap.
* On a tier-**up** above the player's presets, a small notice above the ammo bar offers **Upgrade** or **Keep**.
  Keep is always allowed and suppresses the notice for that tier. With no choice, it hides after 14 s and nothing
  changes.
* Engine events: `disciple:ammotier` (tier-up notice), `disciple:ammo` (current presets),
  inputs `disciple:ammo-upgrade|keep|tier {tier}` and `disciple:ammo-query`.

To retune, edit `AMMO_TIERS` only.

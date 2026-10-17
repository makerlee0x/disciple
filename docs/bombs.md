# Bomb tiers (sell) and thrust (buy): price impact only

Tier is chosen by the trade's **price impact** on the pool (`estimateImpactPct`; for the
player's own shots, `source.impact`). Dollar size and share of the bag are ignored.

| Tier    | Price impact | bps        |
|---------|--------------|------------|
| PUFF    | < 2%         | < 200      |
| GRENADE | 2 – 5%       | 200 – 500  |
| BUNKER  | 5 – 12%      | 500 – 1200 |
| CRUISE  | 12 – 25%     | 1200 – 2500|
| NUKE    | 25 – 50%     | 2500 – 5000|
| ATOM    | ≥ 50%        | ≥ 5000     |

Source: `BOMB_PCT` / `bombTierOf(pct)` in `web/public/flight/engine.js`.

Buy thrust: `impactNorm(pct)` = log-scaled 0 → 1 over 0.05% → 10% impact; drives flame,
flare and the pull-up "fight" (+10 + 28·k degrees, ×1.6 while nose-down).

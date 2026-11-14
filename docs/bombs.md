# Bomb tiers (sell) and thrust (buy): price impact only

Tier is chosen by the trade's **price impact** on the pool (`estimateImpactPct`; for the
player's own shots, `source.impact`). Dollar size and share of the bag are ignored.

| Tier          | Price impact | bps        | key (k)  |
|---------------|--------------|------------|----------|
| GRENADE       | < 2%         | < 200      | puff     |
| BUNKER BUSTER | 2 – 5%       | 200 – 500  | grenade  |
| WARHEAD       | 5 – 12%      | 500 – 1200 | bunker   |
| MOAB          | 12 – 25%     | 1200 – 2500| cruise   |
| ATOM BOMB     | 25 – 50%     | 2500 – 5000| nuke     |
| NUKE          | ≥ 50%        | ≥ 5000     | atom     |

Names renamed and shifted one slot by maker on 2026-11-14 (PUFF and CRUISE MISSILE retired). The keys, CSS tokens
(`--dsc-bomb-<key>-*`), icons (`bomb-<key>`), achievement ids and `BOMB_PCT` constant names kept the old slot names.

Source: `BOMB_PCT` / `bombTierOf(pct)` in `web/public/flight/engine.js`.

Buy thrust: `impactNorm(pct)` = log-scaled 0 → 1 over 0.05% → 10% impact; drives flame,
flare and the pull-up "fight" (+10 + 28·k degrees, ×1.6 while nose-down).

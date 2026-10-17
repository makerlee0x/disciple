# Profile dashboard & identity

Sample-data profile (`/profile`) and achievements (`/achievements`) for DISCIPLE pilots. Stats are computed offline from a trade list; live indexer wiring is a later seam.

## Data shape

`web/lib/stats.ts` accepts `StatsTrade[]` aligned with protocol / indexer Trade events:

| Field | Meaning |
|-------|---------|
| `side` | `buy` (fuel) or `sell` (brake / bomb) |
| `usd` | Gross $ notional |
| `priceBefore` / `priceAfter` | Spot $ around the fill |
| `impactBps` | Price impact in basis points (drives bomb tier) |
| `mcapAfter` | Market cap $ after fill |
| `ts` / `launchTs` | Fill time and rocket launch time (ms) |
| enrichments | `assistedGraduation`, `topFuelerAtGrad`, `isLauncher`, `graduated`, `peakMcap` |

Demo feeds are deterministic seeded histories in `web/lib/mock/sample-trades.ts`, labeled **SAMPLE DATA**, with a Believer / Trencher / Bomber switcher.

## KPI definitions

| KPI | Total | 30-day |
|-----|-------|--------|
| Realized PnL | Sum of closed trade PnL | Fills in last 30d |
| uPnL | Mark − cost on open size | Snapshot |
| Volume | Sum of trade $ | Last 30d |
| % Gain (ROI) | (realized + uPnL) / buy notional | Same on 30d |
| Win rate | Profitable closes / all closes | 30d closes |
| Avg hold | Mean hold hours on closes (+ open) | 30d closes |

**Stat rings:** lifetime PnL, rockets fueled, bombs dropped (impact ≥ grenade), crews joined, best ×, leaderboard rank + top %.

**Gauges:** points behind #1, points to next season rank (`SEASON_RANKS`).

**Charts:** cumulative realized PnL, daily volume bars, hold-time histogram, PnL calendar heatmap.

**Playstyle:** PvE (fueling, holding, crew joins, graduations) vs PvP (bombs, impact, dumps-into-pumps, quick flips).

**Trait radar (0–100):** Conviction, Aggression, Timing, Sniping, Diamond Hands, Crew Spirit.

## CT flavor stats

| Stat | Definition |
|------|------------|
| Rugged count | Price after entry ≤5% of entry |
| Rounds tripped | ≥2× peak while held, then closed at a loss |
| Biggest W / L | Best / worst single close $ |
| Fumbled bag | $ left vs peak price since entry |
| Time in trenches | Hours from first sample trade to now |
| Ape score | Composite of buys, short holds, rocket count |
| Graduations witnessed | Distinct rockets marked graduated |

## Season rank & level

- **Season rank** (`SEASON_RANKS`): Unranked → Novice → Ascendant → Blessed → Anointed → Glorified → Divine by rHALO points. Banner border uses the rank color.
- **Level / XP** (`levelFromPoints`): soft curve `~100 · level^1.35` XP per level.
- Hold bonus remains off-chain points only (`HOLD_BONUS`).

## Identities (`web/lib/identity.ts`)

Thresholds in `IDENTITY_THRESHOLDS` (`web/lib/config.ts`). Primary = highest-weight match; up to three secondary tags.

| Identity | Rule |
|----------|------|
| Believer | Avg hold ≥ 12h and held through ≥35% drawdown |
| Trencher | Avg hold ≤ 8m and ≥ 40 trades |
| Sniper | ≥35% of buys within 120s of launch (min 5 buys) |
| Diamond Hands | Held through ≥50% drawdown while still open |
| Paper Hands | ≥5 sells within 5m on ≤8% dips |
| Exit Liquidity | ≥3 buys near local high then ≥40% drawdown |
| Whale | Top 1% by size percentile |
| Degen | ≥15 distinct rockets and ≥60 trades |
| Bag Holder | Open uPnL ≤ −50% for ≥24h |
| Jeet | ≥3 dumps within 10m after ≥1.5× pump |
| Bomber | ≥8 bombs (impact ≥ grenade / 2%) |
| Nuker | ≥2 nukes/atoms (impact ≥25%) |
| Crew Captain | Top fueler on ≥2 graduated rockets |
| Gate Keeper | ≥3 Outer Space assists |
| Launcher | ≥1 rocket launched |
| Dev Supporter | ≥1 graduated launch |
| Kingmaker | Early fuel on ≥2 rockets that hit Morning Stars+ |
| Farmer | ≥5,000 points with realized PnL ≤ $50 |
| Smart Money | Top-decile ROI with ≥10 closes |

Unmatched pilots fall back to **Pilgrim**.

## Achievements (`web/lib/achievements.ts`)

44 framed trophies in Flight, Crew, Bombs, Conviction, Launcher, Trencher, Seasonal. Rarity frames: Common → Blessed → Anointed → Glorified → Divine. States: locked / in-progress / unlocked. Season pass XP track at top of `/achievements`.

Bomb impact tiers: Puff <2%, Grenade ≥2%, Bunker ≥5%, Cruise ≥12%, Nuke ≥25%, Atom ≥50%.

## Demo personas

| Persona | Intent |
|---------|--------|
| Believer | Long holds, gate assists, crew captain, few bombs |
| Trencher | Many snipes + quick flips across many rockets |
| Bomber | Large sells with grenade→atom impact |

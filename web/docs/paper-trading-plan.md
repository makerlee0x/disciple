# Paper Trading (1 player vs 200 bots): build plan

Status: DRAFT plan + prototype (PR `game/paper-trading-proto`). Source spec: *DISCIPLE - Paper Trading Bot Mode - Dev Spec v0.2* (13 pp).
Author: Grok Bot for maker lee, Oct 30 2026. Goal (lee): a simulated mode we can use to **sharpen the real game mechanics**.

Legend: **[SPEC]** = straight from v0.2 · **[ASSUMPTION]** = spec is silent, default picked here · **[TUNE]** = starting value.

---

## 0. TL;DR

* **One seeded, deterministic round engine in plain TypeScript** (`web/lib/paper/`), with no DOM and no network. It runs in the browser
  today (main thread; it is cheap, ~20–120 ms of CPU for a *whole* 10-minute round with 201 wallets), and the same module can run in a
  Web Worker or a Node game server later without changes.
* **Real mechanics are imported, not copied.** The curve, the 1% fee, the sniper-tax table and the post-ASCEND pool come from `lib/sim/market` +
  `lib/sim/config LAUNCH` (which are built from `lib/config CURVE` + `lib/curveMath`, the mirror of `CurveMath.sol`). Holding caps
  come from `lib/modeRules`. The crew tip follows `BondingCurve._crewTip` and `_pveOnSell`, with its constant checked against `Constants.sol` in a test.
* **One bot brain, parameter table per tier × archetype** (`lib/paper/config.ts`), lobby mixes exactly as spec Sec. 6.
* **Recommended run location: client-side seeded sim now (prototype + tuning), server-authoritative later only if results
  become competitive/public.** See §3.
* Every round exports **JSON + CSV** (curve path, every trade with fee/gas/sniper tax/crew tip, standings, per-archetype PnL, graduation
  time, leader changes). `npm run paper:suite` runs N seeded matches per difficulty for tuning.

## 1. Bot behaviour per difficulty

### 1.1 One brain (spec Sec. 5)
Every bot, every decision tick, runs the same policy (`PaperRound.decide`):

1. **Observe**: only public state, delayed by the bot's *reaction delay*. That means the mcap path it would see on screen `react` ticks ago,
   momentum over its lookback windows, the table VWAP (Hard only), % sold / distance to ASCEND (Medium: % sold, Hard: + flow), and its own
   cash/bag/cost basis. It never sees the backdrop's future phases, the player's queued intents, or other bots' plans.
2. **Score** in roughly [-1, 1]: `wMom·momentum + wRev·(below VWAP / dip) + wCurve·curve position + wMood·current backdrop mood + jitter`.
3. **Decide**: risk rules run first (stop: none / panic −35% / fixed −12% / trailing −8%; take-profit ladder; max hold; first-red-tick for
   Paper Hands; scale-out near ASCEND for Hard). Then buy if score > buyThreshold, sell if score < sellThreshold.
4. **Size**: `startCash × SIZE_SCALE[lobby] × size(conviction)`, capped by per-entry `maxPos × maxEntries` exposure, by the
   **holding cap read from the coin** (same as the HUD rules line) and by cash − gas. Easy rounds buys to the $10/25/50/100 presets (its tell).
   Hard has a minimum trade size (gas-aware) and a cooldown between its own trades.
5. **Execute** through the same `buy()`/`sell()` the player uses: no priority, no fee discount, fill = whatever the curve gives.

Noise: with probability `noise × 0.25 × phase volatility` a decision becomes a random trade **[ASSUMPTION: spec "noise / random trades
25–30%" read as share of trades, not share of decisions; at 100% of decisions Easy bots paid ~1/3 of their stack in gas]**.
Every numeric parameter is jittered ±12% per bot from the seed **[SPEC ±10–15%]**. Bot decision slots are staggered by a seeded phase
offset, and within a tick all due actions (bots + player intents) are applied in a seeded shuffled order **[SPEC Sec. 7]**.

### 1.2 Parameter table (data, `lib/paper/config.ts`; all TUNE)

| | Easy | Medium | Hard |
|---|---|---|---|
| reaction delay | 2.0–3.0 s | 0.8–1.2 s | 150–250 ms |
| decision interval | 2.0 s | 1.0 s | 0.5 s |
| noise | ~27% | ~10% | ~2.5% |
| lookback | 2 s | 5 s + 30 s | 3 s + 20 s + 60 s + VWAP |
| stop | panic −35% (FOMO: none) | −12% fixed | trailing −8% from peak |
| take profit | +15% all out (Paper Hands +10%) | 1/3 at +25%, 1/3 at +50% | ladder +20/40/70% (Exit Artist: 4 steps from +12%), scale-out near ASCEND |
| dip buying | no | −10% from 30 s high | near/below VWAP, tranches |
| curve awareness | none | % sold, skips the 7 s sniper window | % sold + flow, skips sniper window, no fresh entries above 90% |
| max position | 80% of cash, 1 entry | 50% × 1.4 | 35% per entry × 2.6 (scaled) |
| min trade / cooldown | $0 / 3 s | $5 / 4 s | $12 / 5 s |
| active from | 0–420 s | 8–300 s | 8–240 s |
| Paper Rating | 800–1,200 | 1,300–1,700 | 1,900–2,400 |

Archetypes (overrides on the tier row): FOMO Chaser, Paper Hands, Diamond Bagholder (Easy); Scalper, Swinger (Medium); Sniper, Exit
Artist, Dip Accumulator (Hard). Split inside a tier: Easy 40/35/25, Medium 50/50, Hard 34/33/33 **[ASSUMPTION]**.

### 1.3 Lobby mix (spec Sec. 6, exact)
Easy 140/50/10 · Medium 60/100/40 · Hard 20/60/120 (Easy/Medium/Hard bots). For a smaller `botCount` (spec P0 = 20) the mix scales proportionally.

`SIZE_SCALE` per lobby: Easy 1.0, Medium 0.13, Hard 0.11 **[ASSUMPTION/TUNE]**. Without it, Medium and Hard lobbies ($100K and $200K of gross cash
against ~$6.5K of net buy pressure to ASCEND) graduated in 100% of matches at around 2–3 minutes. It is symmetric: it changes how bots size their bets, not what
they may do. The player is not scaled.

## 2. Real mechanics reused from main

| Mechanic | Where it comes from (imported) | Contract source (read only) |
|---|---|---|
| Bonding curve m(g) = M0/(1−a·g)² + T·g³⁰, $3,333 → $33,333, 84.24% sold | `lib/sim/market.ts Market` (float mirror), params from `lib/sim/config LAUNCH` ← `lib/config CURVE` + `lib/curveMath` | `CurveMath.sol`, `Constants.sol` |
| Net buy to ASCEND R(1) ≈ **$6,454.55** (spec says ~$6,500 ✔) | `Market.reserveAt(1)` | same |
| 1% trade fee (buy: before curve, sell: from output) | `Market.fee` ← `TRADE_FEE_BPS` | `FeeMath` |
| Sniper tax 99 · 25 · 3 · 1 · 0.3 · 0.1 · 0.03% for seconds 0–6, buys only | `Market.antiSnipe` ← `CURVE.antiSnipeBpsBySec` (= `lib/snipe snipeFeeBpsAt`) | `Constants.ANTI_SNIPE_TABLE`, `FeeMath.snipeBps` |
| Holding cap, linear in mcap (Easy coin 1% → 3.33%, Hard coin 3.33% → 7.77%) | `lib/modeRules HOLDING_CAP_BPS`, `CAP_MCAP_*` (+ partial fill like the curve) | `BondingCurve.netCapNow` |
| Crew tip: 0.777% of net sell proceeds if realized profit > 0.5% of pre-sale mcap; split over other holders' NET | `lib/paper/engine.ts sell()` (`CREW_TIP_PPM` and threshold asserted against `Constants.sol` in the test) | `BondingCurve._crewTip`, `_pveOnSell`, `_distributeTax` |
| ASCEND → v4 full-range pool at the curve-end price (+ floor bands) | `Market.graduate`, `lib/sim/pool.ts Pool` | `Migration.sol`, `LockedLP`, `FloorBands.sol` |
| BOOST presets $10/25/50/100, DUMP 10/25/50/100% | same values as `lib/config MODES` | n/a |

Parity is tested (`npm run test:paper`). A paper buy fills within 1e-6 of `curveMath.quoteBuy` (bigint), a sell within 1e-5 of `quoteSell`,
mcap(g) matches `curveMcapAtFrac`, the sniper tax matches `snipeFeeBpsAt` for every second, and the caps and tip constants are parsed from Constants.sol.
The existing `npm run test:sim-parity` already pins `lib/sim` to the contracts.

Paper-only, per spec: **$0.25 sample gas per trade** (from cash, never into the curve), scoring, rounds.
Spec mismatch to flag: v0.2 Sec. 4 says "any-pair curve from ~$7K to ~$33K". Main's curve starts at **$3,333** (`CURVE.startMcap`). The prototype
uses main. **[ASSUMPTION: the paper coin is an *Easy-mode* coin (main's default launch mode)]**, so the cap is 1% → 3.33% and the crew tip is on.
`coinMode` is a config field, so Hard/Trench coins are a one-line change.

Not modelled yet: creator tax (default 0), tramps & walls in paper rounds (`lib/sim` has them), the Easy login gate (meaningless for bots),
and post-ASCEND trading (the round ends at ASCEND per spec, so the pool is only used to price the exit cost).

## 3. Where it runs, and why

| Option | Cost | Safety / fairness | Fit |
|---|---|---|---|
| **A. Deterministic seeded sim in the browser** (main thread or a Web Worker) | ~0: no infra, no secrets, no RPC; ~0.1 s CPU per round | The player could, in principle, read the seed/bot params from the bundle and cheat **their own** private paper round. Nothing real is at stake | ✔ Prototype, tuning, solo practice |
| B. Same engine in a Vercel function per action | Stateless: would need replay-from-log on every call or KV storage | Server-authoritative, but awkward for a 4 Hz live loop | ✘ |
| C. **Server-authoritative game server** (spec Sec. 3: WS, one in-memory lobby per process) | A long-running Node process (Fly/Railway/etc.), WS infra, ops | Seed + Hard params stay server-only, intents validated, rate-limited | ✔ Needed once results are **public / ranked / rewarded** |

**Recommendation: A now, with C kept open.** The engine is pure and deterministic, so C is "host `PaperRound` behind a WebSocket,
send `state.tick` / `trade.executed` / `leaderboard` deltas" with no rewrite. Spec v0.2 approves C. The tradeoff: C's cheat resistance only
matters when a paper result is worth something to someone else (leaderboards, ratings, rewards: open question 2). Until then, A is
cheaper, has zero prod risk (no new server, no env, no secrets), and is what lets lee iterate on balance in minutes.
A middle step that's cheap: **verify-by-replay**. The client uploads `{seed, config version, player intent log}`, and a serverless function re-runs
the round (about 0.1 s) to confirm the claimed standings before anything becomes public. That gives most of C's integrity for public results without a live
game server. **[ASSUMPTION: P0/P1 ship as A, and C/verify-by-replay is gated on lee's answer to Q2.]**

Trust-boundary note for A: Hard parameters and the seed are in the client bundle (spec Sec. 3 forbids this for C). That's acceptable for a private solo mode only.

## 4. Rounds and scoring (spec Sec. 2, implemented)

* 1 human + 200 bots = 201 wallets, the same start cash for all (Easy $100 / Medium $500 / Hard $1,000), 0 tokens.
* 10:00 timer, 250 ms engine tick (2,400 ticks). **The round ends at timer expiry or ASCEND, whichever comes first.** It also ends on Quit and End Session
  (`player_ended`). Quit and Leave freezes the player's wallet, and the round runs on and still scores it.
* Player intents are validated (cash/tokens, round running) and rate-limited to 5 per second, then queued and applied in the next tick in a seeded random
  position among bot trades.
* **Net worth = cash + tokens × final price − exit cost**, where the exit cost (fee + gas + slippage) is computed by quoting a sale of the whole bag on the end state.
  The quote is on the curve, or in the pool after ASCEND. Each wallet is quoted independently **[ASSUMPTION]**. Ties: exact-penny equality → higher realized PnL → fewer
  fees (tested).
* Sped-up mode: 1x / 10x / 60x wall-clock (same ticks, same results; the seed determines everything).

## 5. Mechanics data surfaced for tuning

Per round (results screen → **DOWNLOAD ROUND DATA**): `paper-<difficulty>-<seed>.json`, `-trades.csv`, `-curve.csv`.

* `curvePath`: mcap every second. `phases`: backdrop phase changes (time, mood, vol).
* `trades[]`: wallet, side, $, tokens, price, **fee, gas, sniper tax, crew tip**, capped?, realized PnL, mcap after.
* `summary`: end reason, **graduation time**, peak/final mcap, % sold, trade count, total **fees / gas / sniper tax (+ hits) / crew tips
  (+ count)**, capped buys, rejected intents, leader changes, *1st place changed in the final minute* (spec drama metric), winner tier/archetype,
  player rank, **avg net worth by tier and PnL % by archetype**.
* `standings[]` + `wallets[]` (cash, bag, realized PnL, fees, gas, tips paid/received per wallet).

Across rounds: `npm run paper:suite [N] [novice|decent|strong]`. It runs N seeded matches per difficulty with a scripted persona (spec Sec. 11) and
prints graduation rate + mean time, persona win/top-10 rate, average net worth by tier, fees/gas/sniper tax, and the drama metric.

Current numbers (30 seeds each, these are TUNE starting points, not balance):

| lobby | ASCEND rate | Decent persona win / top-10 | Strong persona win / top-10 | avg net worth: easy / medium / hard bots |
|---|---|---|---|---|
| Easy ($100) | 0% | 0% / 3% | 3% / 63% | $82 / $38 / $308 |
| Medium ($500) | 33% @ ~354 s | 0% / 0% | 57% / 67% | $530 / $463 / $610 |
| Hard ($1,000) | 63% @ ~367 s | 0% / 0% | 7% / 20% | $918 / $876 / $1,141 |

What this already says about the **real** mechanics (the point of the mode):
1. **ASCEND dominates scoring.** The round ends at the curve-end price, so in graduating matches whoever simply held cheap early tokens wins
   (Diamond Bagholders beat disciplined traders until Hard bots were given scaled entries). This is the same incentive the live game has.
2. **The $0.25 gas is a big tax on a $100 stack.** Easy lobbies burn ~$2.5K gas + ~$2.8K fees out of $20K. That's why the Easy lobby almost never
   reaches the ~$6.5K of net buy pressure.
3. **The sniper tax almost never fires** once bots skip the first 7 s. Second 0 (1% + 99%) leaves nothing to buy with, so on-chain and here such a buy
   gets 0 tokens.
4. **The holding cap binds often**: 1% of supply at launch is only ~$33. Expect a lot of "capped" partial fills in Medium/Hard (thousands per round).
5. **Crew tips are rare**: the 0.5%-of-mcap profit threshold is $16–$166, so only big winners pay it.

## 6. Screens (brief for SITE)

Spec Sec. 8 wants paper mode to reuse the live coin page surfaces. The prototype uses a throwaway plain page at `/paper`. SITE should mock:

1. **Lobby / difficulty picker** (new, small): three cards (Easy/Medium/Hard) showing start stack, bot mix, a one-line feel ("beatable / fair /
   super traders"), the target win band, and a START button. Small print: 10:00 round, ends at ASCEND or time, the fee + $0.25 gas, "simulated, no
   real money". Advanced (dev/tuning only): seed, speed 1x/10x/60x.
2. **Round = the existing coin page** with paper data:
   * Header: **10:00 countdown**, difficulty chip, a "PAPER" marker, and **QUIT**.
   * Your Run: **rank N/201**, net worth, gap to the wallet ahead + to 1st, cash/bag, and separate lines for trade fees, gas, sniper tax and crew tips.
   * Trades feed: bot BOOST/DUMP with name + **BOT tag + rating** on hover/tap. Aggregate tiny trades (largest + count).
   * Crew / Top Boosters → **live leaderboard**: top 5 + the player pinned, with ratings.
   * BOOST $10/25/50/100 and DUMP 10/25/50/100% exactly as live. Rocket/chart unchanged (altitude = price).
   * Quit dialog with two distinct actions, **Quit and Leave** and **Quit and End Session**, plus a reconnecting state (no action).
3. **Results** (new, small): end reason (ASCENDED at m:ss / time / ended), podium 1–3 + the player, the player's best/worst trade, the winner's stats
   (entries, avg entry vs table, exit style = archetype), **Rematch** (same difficulty, new seed), **Change difficulty**, and (dev) **Download
   round data**.
4. Later (P2): "watch how the winner traded" via the existing Replay view fed from the round log, plus the templated bot chat lines.

Prototype screenshots (simulated data): `/workspace/disciple-shots/paper-trading/`.

## 7. Steps and estimates

| Step | Ships | Estimate |
|---|---|---|
| P0a (done in this PR) | engine, one brain, 3 mixes, 200 bots, scoring, quit actions, export, tests, `/paper` prototype, tuning suite | done |
| P0b | lee plays it and gives a tuning pass: SIZE_SCALE, the Easy gas/noise burn, Medium tier sizing, graduation band 25–50% on all three lobbies | 1–2 days |
| P1a | persona acceptance suite at 100 matches/difficulty in CI (Decent inside the Sec. 6 bands), tuning changelog file | 1 day |
| P1b | wire the round into the real coin page surfaces (FlightCanvas/HUD fed by `PaperRound` instead of swaps), behind `/paper` or `?paper=1`, from SITE's mock | 3–5 days |
| P1c | move the engine into a Web Worker (keeps the main thread free for the rocket) | 0.5 day |
| P2 | templated bot chat (reviewed string list), feed aggregation, Replay "how the winner traded", rematch polish | 2–3 days |
| P2+ (if Q2 = public) | verify-by-replay serverless endpoint, or the full WS game server from spec Sec. 3 (lobby lifecycle, reconnect, rate limits) | 1 day / 4–6 days |
| P3 | Paper Rating / MMR, history, cosmetics (separate spec) | n/a |

## 8. Open questions for lee

1. **Public or private results?** (spec Q2) This decides client sim vs server-authoritative / verify-by-replay.
2. **Which coin mode is the paper coin?** Easy (cap 1% → 3.33%, crew tip on) is the assumption. Should Hard/Trench be selectable too?
3. **Should graduation end the match at the curve-end price?** It makes holding early the dominant strategy (finding 1). Alternatives: keep trading 60 s
   in the pool after ASCEND, or score at a post-ASCEND mark.
4. **Gas $0.25 on a $100 stack**: is that intended to punish over-trading this hard (finding 2), or should gas scale with the stack in Easy?
5. **Curve start**: the spec says ~$7K, main has $3,333. Main is used here; is the spec stale?
6. **Bot sizing in rich lobbies** (`SIZE_SCALE`): is it OK that Medium/Hard bots bet a smaller fraction of their stack so that ASCEND stays
   occasional, or would you rather the spec's mechanisms do it (caps, deployment)? Those alone graduated every match by ~3 min.
7. Spec Q1/Q3/Q4: late join, who approves the bot name pool + chat templates, and does paper mode need login (prototype: guest, no login)?
8. Should the round-data export be player-visible, or dev-only (`?dev=1`)?

## 9. Deferred from the spec (not in the prototype)

WebSocket server, lobby HTTP API, reconnect/disconnect, server-only secrets (§3). The `v:1` event payloads are mirrored as plain
objects only. Bot chat templates (P2). Replay viewer (P2; the log needed for it is exported). Persona win-rate bands are measured, not yet met
(see §5). Trades-feed aggregation. Integration into the real coin page/FlightCanvas. The spec's performance budget is trivially met in-browser
(~0.1 s CPU per round), but it hasn't been measured on a server.

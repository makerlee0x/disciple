# DISCIPLE Rockets v0: Design Spec + Economic Model

Status: v0 **build-ready, NOT for release** (contracts in `disciple` repo `contracts/src/rockets/`, branch `feat/rockets-v0`, not wired, not deployed). §0 supersedes conflicting text below. Model: `rockets_model.py` (stdlib; `python3 rockets_model.py`).

## 0. Final decisions (v0 build, 2026-10-15). These override §3-§6 where they conflict.

**Supply/auction (`RocketAuctionHouse`)**
- ERC-721 `Rocket721`, ids 1..777 (hard cap). Day *i*, counted from `genesis`, sells id *i+1*. The first buyer at the current price wins and the rocket mints immediately. Payment is in USDG.
- Schedule uses fixed UTC times, all owner-settable. Genesis is 00:00:00 ET (04:00 UTC under EDT). Days are a fixed 24h and do not shift for DST. Defaults:
  - Start at **77,000 USDG** at 00:00:00.
  - **Exponential** decay `p = start·(reserve/start)^(t/T)`, with T = 22h−10s, so the price hits the **77 USDG reserve by 21:59:50**.
  - The price holds at the reserve until the close at **23:59:50**.
  - At close, buying stops and the unsold id becomes permanently burnable. `burnUnsold` is permissionless. The id is skipped and `liveCap` drops by one.
  - The next auction opens at 00:00:00.
  - `setDecay` enforces close ≤ 24h and a reserve hold of **≥ 2h**. Linear decay is available as an option.
- Pricing modes:
  - **Fixed mode (default):** start = `fixedStartPrice` (77,000) and floor = `reservePrice` (77). The owner can set both.
  - **Feed mode:** start = `startMultiplier` (2.0×) × projected 5-year payout per rocket. Floor = max(reserve, `floorMultiplier` (0.5×) × projection).
    - Projection = (trailing-7d fees / 7) × poolShare (10%) × Σ_{k<1825} 1/min(n+k, liveCap), where n = current supply + 1. This matches the `rockets_model.py` equal-weight dilution.
    - The feed is `RocketFeeFeed`: the owner/keeper posts the 7-day fee total, taken from FeeRouter `TradeFeeRouted` accounting with flagged wash volume excluded.
    - Keeper posts are bounded to ±50% per post. The owner can override that bound.
    - Buys revert if the feed is older than `maxFeedAge` (2d). The auction fails closed rather than selling at a stale price.
    - Why this design: it is the simplest safe option. There is no on-chain TWAP of fee receipts to manipulate, and the trust sits with the existing keeper/multisig.
- Proceeds go 100% to treasury by default. `proceedsToPoolBps` can optionally seed the pool, streamed over N days.

**Holder pool (`RocketPool`)**
- Rockets receive 10% of all protocol fees, carved from the treasury slice. The pool is shared and holds no meme-coin LP.
- On-chain daily epochs:
  - Deposits land in today's bucket.
  - Each rocket that is **ignited** for day *d* earns `dayRewards[d]·w/Σw_active[d]`. This is the per-day rewardPerWeight.
  - Idle rockets earn nothing, and their share automatically goes to active ones.
  - Days with no active rocket roll forward, so funds are never stranded.
  - Claims are pull-based in USDG. Each rocket has at most one unsettled day, so settlement is O(1).
  - Rewards are credited to the owner/renter recorded **at ignite time**. They do not move with a transfer that happens before settlement.
- No Merkle in v0: energy and referral are applied on-chain through reporter/keeper inputs (§5 superseded).

**Weight:** `(1 + 0.1·L) × (1 + referralBps)` in bps. The maximum is 2.0 × 1.25 = 2.5×.

**Leveling:** levels run 0..10. Cumulative cost is **77·L² USDG** (step cost 77·(2L+1)), so L10 costs 7,700 USDG in total. The spend splits 50% to treasury and 50% to the pool, streamed over 30 days. Levels are permanent and travel with the NFT. The unit, split, and stream days are owner-settable.

**Energy (keeps §4 rules except volume-weighting):**
- A wallet is energized for the epoch day when a reporter reports a qualifying action of at least **33 USDG** notional (`minQualifying`, owner-settable). A qualifying action is a trade, a tramp/wall, or a hold through a tier break. The threshold is a flat minimum, not volume-weighted.
- One action covers all of that wallet's rockets.
- Each rocket gets **1 grace (autopilot) day per 7-day window**.
- Missed days mean no earnings, and there is no penalty or decay.
- `ignite(tokenId)` is permissionless, so agents and automation can run it daily. Energy comes from the renter while the rocket is rented.
- Wash and self-trade filtering is the reporter's job. The reporter role is the trust boundary.

**Referral:** the keeper posts per-wallet `referralBps` ≤ 2500 (+25%), using the §4 formula with same-funder and wash exclusions computed off-chain.

**Rentals:** ERC-4907 (`setUser`/`userOf`/`userExpires`) plus `setRental(user, expires, renterBps, locked)`. The owner sets the renter's share per rental.
- An unlocked rental is cleared on transfer (EIP-4907).
- A locked rental blocks both transfer and override until it expires.

**Out of scope:** repairs, breeding, platform token, redemption.

**Integration (not wired):** `IRocketFeeSink.depositFees` / `reportActivity` (see §10).

## 10. Integration notes (not implemented in live contracts)
- FeeRouter v-next: in `_route`, compute `rocketShare = fee × 10%` (default 1000 bps of the fee, taken out of `treasuryShare`).
  - For a USDG quote: `approve` + `RocketPool.depositFees(rocketShare)`.
  - For other quotes: send to a keeper escrow, then swap TWAP-guarded and deposit.
  - FeeRouter must be `setDepositor`. Wrap the call in try/catch, or escrow, so a pool revert never blocks trades.
- Activity: the Router/hook (or an indexer keeper consuming `TradeFeeRouted` / tramp-wall / tier events) calls `reportAction(wallet, kind, notional)`. The keeper gets the `setReporter` role.
- Auction feed: the keeper posts the trailing-7d fee total daily, before 00:00 ET.
- Deploy order: Rocket721 → AuctionHouse → Pool → Feed. Then `setMinter`, `setPool` (on both), and `setFeed`. Transfer ownership to the multisig.

## 11. Open questions (v0 build)
1. Grace is per rocket per fixed 7-day window. Should it instead be per wallet, or a rolling 7 days?
2. Fixed 77,000 start versus feed mode at launch. Which one, and when do we switch?
3. Is the fixed UTC genesis acceptable? The ET open drifts by 1h at DST changes.
4. Should a referral boost be snapshotted at ignite (current behavior) or recomputed?
5. A reporter key can energize arbitrary wallets. Do we need a multisig reporter or rate limits?
6. Rewards are credited to the owner at ignite, even if the NFT is sold before settlement. Is that OK?
7. Legal review (§7) is still required before any release.

## 1. Summary
Rockets are 777 ERC-721s, one sold per day by Dutch auction (~2.13 yrs). Holders share **10% of all protocol fees** (carved from the 33% treasury slice), pro-rata by weight, paid in **USDG** from a shared pool. Rockets carry no meme-coin LP exposure, there is no treasury redemption, and no platform token. Launch is gated on sustained $1M/day volume.

## 2. Fee flow
Per trade: 1% fee → 33% creator / 33% LP / 33% treasury / 1% other.
Rocket pool = 10% × fee = 0.10% of volume. Treasury keeps 33% − 10% = **23% of fees** (0.23% of volume).
At $1M/day: pool $1,000/day ($30K/mo), treasury kept $2,300/day (**$69K/mo**).
Fees in STRATEGY are swapped to USDG before they enter the pool (keeper, TWAP-guarded).

## 3. Auction
- One rocket per day, Dutch decay over 24h from **Start** to **Floor**. The first bid wins (Nouns-style settle-and-start-next).
- `P1y(n)` = the rocket's projected 1-year payout from trailing 7-day volume, with dilution included (equal weights assumed).
- Start ≈ 10× P1y, Floor ≈ 3× P1y. Unsold at floor → **burned**, and the cap drops (777 → 776…). Burns raise the share each remaining rocket gets.
- Proceeds → treasury (suggested split: 100% treasury; optional 0-20% seeds the pool).
- **⚠ Calibration conflict (key finding):** the baseline "50% of 5-year payout" price is 0.66× P1y for #1 and 2.5× for #777. That puts it *below* the locked 3× floor for every rocket. Under flat volume, a floor buyer of #1-#30 **never pays back**, because dilution caps lifetime earnings. Options: (a) define the floor as ~0.5× of the 5-year payout (≈0.7-2.5× P1y); (b) keep 3×/10× but compute P on a *5-year diluted* basis; (c) accept that most rockets burn early. Recommendation: (a). Start = 2× the 5-year payout, floor = 0.5× the 5-year payout.

## 4. Mechanics
### Weight
`weight = base(1.0) × level_mult (≤2.0) × referral_mult (≤1.25)`, hard cap 2.5×. Daily share = `pool_day × w_i·E_i / Σ w·E`.

### Leveling (proposed curve)
- Level L ∈ 0..10, `level_mult = 1 + 0.1·L`, cumulative cost `C(L) = k·L²` USDG with k = 77 USDG at launch (final). Per-step cost is 100·(2L−1), so each step costs more, which gives diminishing returns.
- Index k to the pool, e.g. `k = 0.1 × 30-day pool average / 30`, so leveling stays meaningful as volume grows.
- Spend split: **50% treasury / 50% payout pool**, streamed over 30 days so it can't be gamed with a one-shot spend. Levels are permanent and travel with the NFT. There is no un-leveling.
- Effect: a max-level rocket earns 2× a base one, and every leveling also dilutes all other holders. Holders should be told this plainly.

### Energy (proposed rules)
- A rocket is **energized for a UTC day** if its holder (or its renter, if rented) did ≥1 of these in that day:
  1. traded ≥ $50 notional (USDG-equivalent) on DISCIPLE pairs, net of round-trip self-trades in the same block/pair;
  2. a tramp or wall action ≥ $50;
  3. held a position ≥ $50 through a tier break of that token.
- Idle rockets earn 0 that day. Their share goes to energized rockets pro-rata by weight. The pool is never left unspent.
- Grace: 1 free "autopilot" day per 7 (stops a single missed day from wiping out a week's earnings).
- Activity counts once per wallet per day, so one wallet holding 10 rockets only needs one action. This is deliberate: the system doesn't reward splitting rockets across sybil wallets.

### Referral boost (anti-sybil)
- Referred wallets must be new: first DISCIPLE trade after the referral link, and wallet age/funding is checked by the indexer.
- The boost is `1 + min(0.25, referred_fee_30d / pool_30d_per_rocket × 0.25)`, recalculated daily on a 30-day rolling window.
- Only **net, non-wash** volume counts: excludes the same funding source, circular trades, and volume < 24h holding on low-liquidity pairs. Referred wallets that share a funder with the referrer score 0.

### Rentals (ERC-4907-style)
- The owner sets a `user` and an `expires`, with `renterBps` (e.g. 7000 = 70% to the renter). Energy is tracked from the **user's** activity during the rental.
- Claims split on-chain at claim time by the bps in effect for each day; the indexer emits per-day (owner, user, bps) records. Transferring the NFT clears the user (EIP-4907 semantics) unless the rental is locked. Proposal: a locked rental blocks transfer until it expires, so the renter's earnings are protected.
- No repairs, no breeding.

## 5. Distribution: off-chain indexer + Merkle claim
- Daily epoch: the indexer computes `Σ w·E` and per-rocket USDG, then posts a cumulative Merkle root to `RocketDistributor` (multisig/role + 24h challenge delay). Holders claim cumulative minus already-claimed. Unclaimed amounts accrue indefinitely, and claims are paid to the owner/renter recorded at each epoch.
- A fully on-chain version is simple only *without* energy and referrals: a `rewardPerWeight` accumulator updated on fee deposit (MasterChef-style). Recommendation: put the base accumulator on-chain for v0.5, then add energy/referral as an off-chain Merkle overlay.

## 6. Contract architecture (proposed, not implemented)
- `Rocket721`: ERC-721 + IERC4907, levels stored per token, `burnUnsold`, cap tracking.
- `RocketAuctionHouse`: daily Dutch auction, reads a 7-day volume oracle (indexer-signed or TWAP of fee receipts), settles into the treasury.
- `FeeRouter` change: route 10% of fees → `RocketPool` (USDG; swap STRATEGY via keeper).
- `RocketDistributor`: Merkle roots, cumulative claims, rental split, pause.
- `LevelVault`: takes USDG, mints levels, streams the 50/50 split.
- Explicitly **absent**: any redemption/ragequit, treasury NAV claim, governance over the treasury by rocket holders.

## 7. Risks
- **Securities framing:** a fee-share NFT sold at auction looks like a profit-sharing instrument. Use product language ("rocket", "fuel", "rewards for active players") and avoid "investment", "yield", "ROI", "dividend" in UX and marketing. Energy (rewards require activity) and no redemption help but are not a safe harbor. **Get legal review before launch**; consider geo-gating.
- **Sybil / energy farming:** $50 dust trades to energize. Mitigations: minimum notional, a fee cost per action (1% of $50 = $0.50/day is cheap against payouts of ~$4-18/day per rocket at $1M/day), so consider a min of fee-paid ≥ X or tier-break-only energy for later rockets. One action per wallet covers all its rockets.
- **Wash volume:** inflates trailing-7-day pricing and referral boosts. Wash trades pay a real 1% fee, of which only 0.1% comes back via the pool, so washing to farm the pool loses money. Washing to pump the auction price only hurts buyers. Exclude flagged volume from the pricing oracle.
- **Dilution / late-buyer math:** rockets after #365 need 800+ days to pay back on flat volume. Their value depends on volume growth.
- **Volume collapse:** payouts scale linearly with volume, and there is no floor.
- **Indexer trust:** Merkle roots are posted by a privileged role. Mitigate with a challenge window, public reproducible indexer, and an on-chain base accumulator.

## 8. Open questions
1. Resolve the floor/start calibration (§3). Is the 3×/10× multiple meant to apply to P1y or to something else?
2. Should auction proceeds go 100% to treasury, or partly seed the pool?
3. Leveling split (50/50?) and whether k is indexed to volume.
4. Energy thresholds ($50?) and whether the grace day is included.
5. Does a burned rocket permanently reduce the cap, and does the daily schedule continue to day 777 regardless?
6. Merkle vs on-chain accumulator for v0.
7. STRATEGY→USDG conversion venue and slippage policy.
8. Legal review and geo-restrictions.

## 9. Model output
Assumptions: rocket #n sells on day n (no burns), equal weights, 100% energized unless noted. Price is set off trailing flat volume. "Growing" = +100%/yr. Leveling estimate assumes 25% of rockets spend 50% of their auction price on leveling, 50% to treasury.

### Rocket prices & payback (flat volume, 10% share)

| Vol | Rocket | Proj. 1y payout | Price @50% 5y | Floor 3x | Start 10x | Payback d (50%5y) | Payback d (floor) |
|---|---|---|---|---|---|---|---|
| $100.0K/d | #1 | $648 | $429 | $1.9K | $6.5K | 41 | None |
| $100.0K/d | #10 | $367 | $288 | $1.1K | $3.7K | 161 | None |
| $100.0K/d | #30 | $259 | $233 | $778 | $2.6K | 274 | None |
| $100.0K/d | #100 | $154 | $177 | $462 | $1.5K | 483 | 2673 |
| $100.0K/d | #365 | $69 | $129 | $208 | $694 | 825 | 1442 |
| $100.0K/d | #777 | $47 | $117 | $141 | $470 | 913 | 1095 |
| $1.00M/d | #1 | $6.5K | $4.3K | $19.4K | $64.8K | 41 | None |
| $1.00M/d | #10 | $3.7K | $2.9K | $11.0K | $36.7K | 161 | None |
| $1.00M/d | #30 | $2.6K | $2.3K | $7.8K | $25.9K | 274 | None |
| $1.00M/d | #100 | $1.5K | $1.8K | $4.6K | $15.4K | 483 | 2673 |
| $1.00M/d | #365 | $694 | $1.3K | $2.1K | $6.9K | 825 | 1442 |
| $1.00M/d | #777 | $470 | $1.2K | $1.4K | $4.7K | 913 | 1096 |
| $10.00M/d | #1 | $64.8K | $42.9K | $194.4K | $647.8K | 41 | None |
| $10.00M/d | #10 | $36.7K | $28.8K | $110.2K | $367.4K | 161 | None |
| $10.00M/d | #30 | $25.9K | $23.3K | $77.8K | $259.3K | 274 | None |
| $10.00M/d | #100 | $15.4K | $17.7K | $46.2K | $154.1K | 483 | 2673 |
| $10.00M/d | #365 | $6.9K | $12.9K | $20.8K | $69.4K | 825 | 1442 |
| $10.00M/d | #777 | $4.7K | $11.7K | $14.1K | $47.0K | 913 | 1095 |

### Rocket prices & payback (growing volume, 10% share)

| Vol | Rocket | Proj. 1y payout | Price @50% 5y | Floor 3x | Start 10x | Payback d (50%5y) | Payback d (floor) |
|---|---|---|---|---|---|---|---|
| $100.0K/d | #1 | $648 | $429 | $1.9K | $6.5K | 38 | 1552 |
| $100.0K/d | #10 | $367 | $288 | $1.1K | $3.7K | 123 | 1245 |
| $100.0K/d | #30 | $259 | $233 | $778 | $2.6K | 178 | 1051 |
| $100.0K/d | #100 | $154 | $177 | $462 | $1.5K | 235 | 761 |
| $100.0K/d | #365 | $69 | $129 | $208 | $694 | 246 | 394 |
| $100.0K/d | #777 | $47 | $117 | $141 | $470 | 176 | 205 |
| $1.00M/d | #1 | $6.5K | $4.3K | $19.4K | $64.8K | 38 | 1552 |
| $1.00M/d | #10 | $3.7K | $2.9K | $11.0K | $36.7K | 123 | 1245 |
| $1.00M/d | #30 | $2.6K | $2.3K | $7.8K | $25.9K | 178 | 1051 |
| $1.00M/d | #100 | $1.5K | $1.8K | $4.6K | $15.4K | 235 | 761 |
| $1.00M/d | #365 | $694 | $1.3K | $2.1K | $6.9K | 246 | 394 |
| $1.00M/d | #777 | $470 | $1.2K | $1.4K | $4.7K | 176 | 205 |
| $10.00M/d | #1 | $64.8K | $42.9K | $194.4K | $647.8K | 38 | 1552 |
| $10.00M/d | #10 | $36.7K | $28.8K | $110.2K | $367.4K | 123 | 1245 |
| $10.00M/d | #30 | $25.9K | $23.3K | $77.8K | $259.3K | 178 | 1051 |
| $10.00M/d | #100 | $15.4K | $17.7K | $46.2K | $154.1K | 235 | 761 |
| $10.00M/d | #365 | $6.9K | $12.9K | $20.8K | $69.4K | 246 | 394 |
| $10.00M/d | #777 | $4.7K | $11.7K | $14.1K | $47.0K | 176 | 205 |

### Treasury (flat volume, 10% share)

| Vol | Period | Gross treasury fees | Fees kept (after pool) | Auction sales (50%-100% of 5y) | Leveling to treasury (est.) |
|---|---|---|---|---|---|
| $100.0K/d | Month 1 | $9.9K | $6.9K | $8.4K-$16.8K | $1.1K |
| $100.0K/d | Year 1 | $120.5K | $84.0K | $60.9K-$121.8K | $7.6K |
| $100.0K/d | Year 2 | $120.5K | $84.0K | $44.2K-$88.4K | $5.5K |
| $100.0K/d | Year 3 (to #777+) | $120.5K | $84.0K | $5.5K-$11.0K | $690 |
| $1.00M/d | Month 1 | $99.0K | $69.0K | $84.1K-$168.2K | $10.5K |
| $1.00M/d | Year 1 | $1.20M | $839.5K | $609.2K-$1.22M | $76.1K |
| $1.00M/d | Year 2 | $1.20M | $839.5K | $442.1K-$884.3K | $55.3K |
| $1.00M/d | Year 3 (to #777+) | $1.20M | $839.5K | $55.2K-$110.4K | $6.9K |
| $10.00M/d | Month 1 | $990.0K | $690.0K | $840.9K-$1.68M | $105.1K |
| $10.00M/d | Year 1 | $12.04M | $8.39M | $6.09M-$12.18M | $761.4K |
| $10.00M/d | Year 2 | $12.04M | $8.39M | $4.42M-$8.84M | $552.7K |
| $10.00M/d | Year 3 (to #777+) | $12.04M | $8.39M | $552.1K-$1.10M | $69.0K |

### Treasury (growing volume, 10% share)

| Vol | Period | Gross treasury fees | Fees kept (after pool) | Auction sales (50%-100% of 5y) | Leveling to treasury (est.) |
|---|---|---|---|---|---|
| $100.0K/d | Month 1 | $10.2K | $7.1K | $8.4K-$16.8K | $1.1K |
| $100.0K/d | Year 1 | $173.9K | $121.2K | $60.9K-$121.8K | $7.6K |
| $100.0K/d | Year 2 | $347.9K | $242.5K | $44.2K-$88.4K | $5.5K |
| $100.0K/d | Year 3 (to #777+) | $695.8K | $484.9K | $5.5K-$11.0K | $690 |
| $1.00M/d | Month 1 | $102.0K | $71.1K | $84.1K-$168.2K | $10.5K |
| $1.00M/d | Year 1 | $1.74M | $1.21M | $609.2K-$1.22M | $76.1K |
| $1.00M/d | Year 2 | $3.48M | $2.42M | $442.1K-$884.3K | $55.3K |
| $1.00M/d | Year 3 (to #777+) | $6.96M | $4.85M | $55.2K-$110.4K | $6.9K |
| $10.00M/d | Month 1 | $1.02M | $710.7K | $840.9K-$1.68M | $105.1K |
| $10.00M/d | Year 1 | $17.39M | $12.12M | $6.09M-$12.18M | $761.4K |
| $10.00M/d | Year 2 | $34.79M | $24.25M | $4.42M-$8.84M | $552.7K |
| $10.00M/d | Year 3 (to #777+) | $69.58M | $48.49M | $552.1K-$1.10M | $69.0K |

### Energy: active-holder yield, rocket #100 @ $1M/d flat

| Active share of weight | Active multiplier | Active 1y payout | Payback d (active) |
|---|---|---|---|
| 100% | 1.00x | $1.5K | 483 |
| 80% | 1.25x | $1.9K | 310 |
| 60% | 1.67x | $2.6K | 188 |
| 40% | 2.50x | $3.9K | 103 |
| 25% | 4.00x | $6.2K | 56 |

### Sensitivity 5% vs 10% share @ $1M/d flat

| Share | Rocket | Pool/month | Treasury kept/month | Price @50% 5y | Payback d |
|---|---|---|---|---|---|
| 5% | #1 | $15.0K | $84.0K | $2.1K | 41 |
| 5% | #30 | $15.0K | $84.0K | $1.2K | 274 |
| 5% | #365 | $15.0K | $84.0K | $644 | 825 |
| 10% | #1 | $30.0K | $69.0K | $4.3K | 41 |
| 10% | #30 | $30.0K | $69.0K | $2.3K | 274 |
| 10% | #365 | $30.0K | $69.0K | $1.3K | 825 |

### Leveling curve: cost(L)=100*L^2 USDG cumulative, weight=1+0.1L (cap 2.0x)

| Level | Weight | Cumulative USDG | USDG per +1.0x weight |
|---|---|---|---|
| 0 | 1.0x | 0 | 0 |
| 1 | 1.1x | 100 | 1000 |
| 2 | 1.2x | 400 | 2000 |
| 3 | 1.3x | 900 | 3000 |
| 4 | 1.4x | 1600 | 4000 |
| 5 | 1.5x | 2500 | 5000 |
| 6 | 1.6x | 3600 | 6000 |
| 7 | 1.7x | 4900 | 7000 |
| 8 | 1.8x | 6400 | 8000 |
| 9 | 1.9x | 8100 | 9000 |
| 10 | 2.0x | 10000 | 10000 |

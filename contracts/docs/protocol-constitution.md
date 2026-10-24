# DISCIPLE Protocol Constitution

**Product:** DISCIPLE (formerly ANYPAIR)  
**Date:** 2026-10-15  
**Scope:** v0 — Robinhood Chain only  
**Owner agent:** DISCIPLE FLOW (backend / contracts)  
**Game UI/UX (incl. nuke art):** DISCIPLE GAME  

This document is the source of truth for locked product and protocol decisions. Deferred items are listed at the end; do not treat them as in-scope for v0.

---

## LOCKED Decisions Table

| # | Area | Decision | Status |
|---|------|----------|--------|
| 1 | Product | Name is **DISCIPLE** (was ANYPAIR) | LOCKED |
| 2 | Chain | v0 = **Robinhood Chain only**; mainnet / cross-chain → v2 | LOCKED |
| 3 | Product surface | Spot launchpad + gamified chart; rocket game on **disciple.vip** (GAME) | LOCKED |
| 4 | Deferrals | Papertrade / leverage deferred; **no native protocol coin** at launch; external ERC-20 quotes only | LOCKED |
| 5 | Architecture | **Option B:** external bonding curve (**single steep Pump-style CPAMM**) + **same-tx** Uniswap v4 migrate (init at curve-end sqrtPriceX96 — **no price jump**; full-range LP owned forever by LockedLP); **no migration pause/gap** | LOCKED 2026-10-15 |
| 6 | Curve levels | Start mcap **$7,777** → graduation **$33,333** (Outer Space); single CPAMM hits grad at the curve sold %. **Sold % pending lee's pick:** 72% (current, `CURVE_SOLD_BPS = 7200`) / 67.4% (CP, no leftover) / 50% (rest → 0xdEaD) | LOCKED 2026-10-15; endpoints rev. 2026-10-23 (sold % open) |
| 7 | Supply on curve | **~72%** sold on curve (sold % pending, see #6); **1,000,000** total supply (lee sign-off 2026-10-23; no burn); fixed at launch, no further mint; **18 decimals** ERC-20 | LOCKED |
| 8 | Wallet cap | Bonding curve only (not post-grad). **Easy (PVE):** NET holding cap **1% → 3.33%** of supply, linear in mcap $7,777 → $33,333. **Hard (PVP):** **3.33% → 7.77%**. Measured at the pre-trade mcap. **TRENCH:** legacy `Launchpad.walletCapBps` (default 0 = no cap, owner-settable, snapshotted per coin). Over-cap buys **partial-fill** to the cap and refund the rest (no revert; room 0 reverts `WalletCap`). No max buy / max sell. **No wallet exemptions** except the First BOOST for its own buy (#27). See mode-rules-v2.md | LOCKED 2026-10-23 (rev., was walletCapBps-only / 7%) |
| 9 | Anti-snipe (sniper tax) | **All modes, curve only:** buy-side tax **99% → 0% linearly over 77 s** after launch (then only the protocol 1% + creator tax). Held in the curve's **`snipeEscrow`**, outside reserves and price; **at graduation it goes to LockedLP's locked compound bucket (not the floor)**; if the coin has not graduated **30 days** after launch (owner-tunable for future launches, 1–365 days, snapshotted), **anyone** can send it to the community RewardsVault. **First BOOST exempt.** The 70/30 vault/treasury routing and the launch-block rule are removed | LOCKED 2026-10-23 (rev., was 77.7%→0 over 7 s, 70/30; window 60 s → 77 s 2026-10-23) |
| 10 | Token address | Standard **CREATE**; no vanity | LOCKED |
| 11 | Trade fee | **1%** trade fee → **33%** creator / **33%** LP share / **33%** treasury / **1%** leftover. **Leftover priority:** (1) the coin's launch KOL (referrer of the creating wallet, #21) if set, else (2) the trader's referrer, else (3) treasury. Curve phase: the LP share is escrowed in LockedLP and folded into the graduation seed. Post-grad: the LP share goes to LockedLP and is **auto-compounded in batches** into the locked full-range position (#16: added once the matched amount reaches **0.1%** of the position's liquidity, capped at **0.5%** per 60 s window and one add per block) | LOCKED |
| 12 | Creator tax | Optional; default **0%**, optional **≤7%**, **immutable at launch**; on top of 1% fee. **Curve-only:** charged on bonding-curve trades; after graduation the hook charges the flat 1% only (no creator tax) | LOCKED |
| 13 | Creator fees | Accrue on-chain; **pull/claim anytime** | LOCKED |
| 14 | Treasury fees | **Auto-push** each trade | LOCKED |
| 15 | LP-lock quote | Curve phase: escrowed in LockedLP each trade, seeded into the locked v4 position at graduation (any quote the full-range add cannot pair goes into the coin's compound quote bucket, event `GraduationLeftover`, and pairs with incoming token fees over time). Post-grad: auto-compounded per trade (#16) | LOCKED |
| 16 | Post-grad LP fees | v4 **pool LP fee = 0**; **1% DiscipleHook only**. Split 33 creator / 33 LP / 33 treasury / 1 referral; the **full 33% LP share goes to LockedLP and is auto-compounded in batches** into the coin's permanently locked full-range v4 position: every trade fills a bucket (buys the token bucket, sells the quote bucket), and the matched amount is added to the same locked position only once it reaches the minimum (default **0.1% of the position's liquidity**, `minCompoundPpm` 1,000, owner-settable), so adds batch across many trades; the unmatched remainder carries forward. Guards: at most **0.5%** of position liquidity per 60 s window and one add per block (`maxCompoundPpm` 5,000), skip unless spot is within 3% of the swap's pre-price, the block-start price and the 60 s EMA (owner-settable), the add can never revert a trade, no rebalancing swaps. Anyone can call `LockedLP.flush(token)` to top up outside a swap. **No in-range donation** (`PoolManager.donate` removed 2026-10-16): tramps/walls earn no yield. Total fee stays 1%. | LOCKED 2026-10-16 |
| 17 | LP lock | Permanently locked at graduation in **LockedLP** (v4 position owner); fee collection allowed; **no remove-liquidity** | LOCKED 2026-10-15 |
| 18 | Referral attribution | First-touch wallet forever after: referral link → account → **USDG deposit ≥ $10** | LOCKED |
| 19 | Self-referral | Same-wallet self-referral **blocked only** | LOCKED |
| 20 | KOL trade share | KOL earns leftover **1% of trade fee** on that wallet’s trades (lifetime) | LOCKED |
| 21 | KOL on creates | On coins that wallet creates: **3% of creator fees** = leftover 1% of fee on those trades to KOL + **2% of creator’s 33% share** | LOCKED |
| 22 | Referrer fees | Accrue; **claim anytime** | LOCKED |
| 23 | Launch access | **Permissionless** — anyone can launch | LOCKED |
| 24 | Metadata (launch) | Like Flaunch: **image + name + ticker required**; description + socials optional | LOCKED |
| 25 | Metadata (post-launch) | Creator can update **image, description, socials** — **NOT** name or ticker | LOCKED |
| 26 | Ownership | Transferable anytime, multi-hop OK; full pack: metadata + fee claim + creator tax rights | LOCKED |
| 27 | Creator buy (First BOOST) | Optional creator buy in the launch tx. Max per mode: **Easy 1.2%**, **Hard 3.33%**, **TRENCH `Launchpad.creatorBuyMaxBps`** (default 0.77%, owner-settable, ceiling 7%, snapshotted). A larger amount partial-fills to the max. Exempt from the holding cap **for that buy only** (counts in NET afterwards) and from the sniper tax. **Easy:** First BOOST tokens are **locked until graduation** (`Token._update`); later buys are free. Easy still requires login | LOCKED 2026-10-23 (rev.) |
| 28 | Deposits / gas | One deposit approval; user pays gas; **no gas sponsorship** | LOCKED |
| 29 | MEV protection | **Deadline + non-zero minAmountOut**, plus a per-swap **price-impact cap on DiscipleRouter** (`maxImpactBps`, default 50%, owner-settable 1%–1000%; router only, direct PoolManager swaps unaffected) | LOCKED |
| 30 | Pause | **No pause** — curves and graduated pools always live | LOCKED |
| 31 | Quotes | **defaultQuote = STRATEGY** (RH chain; owner/multisig settable). `launchCoin`/`launch` with `quote=address(0)` uses defaultQuote; **custom ERC-20 quote** still allowed if it passes probe; no curated allowlist beyond always-pass (STRATEGY/WETH/USDG) | LOCKED 2026-10-15 |
| 32 | Probe | Hard reject honeypot / FoT only; thin depth soft warn; **WETH / USDG always pass** | LOCKED |
| 33 | LP seeding | Curve seeds LP (not maker/creator quote deposit); thin-depth pairs get curve mods for efficient seeding | LOCKED |
| 34 | Treasury | Multisig; team/foundation can change address | LOCKED |
| 35 | Contracts | **Non-upgradeable** (no proxies); changes ship only by **redeploy** (new contracts + migration plan). Owner/admin wiring setters go to a Safe multisig with a timelock before mainnet (security-review.md SEC-04) | LOCKED (rev. 2026-10-17) |
| 36 | Account | Full Privy — X + wallet (embedded + external); USDG cash balance | LOCKED |
| 37 | Deposit | **USDG only** in v0; other EVM assets deferred | LOCKED |
| 38 | Withdraw | USDG on **Robinhood Chain only** | LOCKED |
| 39 | Data / chart | Own RH indexer for trades, mcap, impact; DexScreener optional share link | LOCKED |
| 40 | Nuke tiers | By sell price impact (GAME owns art): &lt;2% puff; 2–5% grenade; 5–12% bunker buster; 12–25% cruise missile; 25–50% nuke; ≥50% atom bomb | LOCKED |
| 41 | Tier ladder | Biblically ascending mcap **ranges** from Launch Pad ($7K–$12K; coins start at $7,777) through Seventh Heaven ($3.3B–$7.77B); Outer Space = $33,333 graduation — see detailed section. Names per disciple-brand/LEXICON.md §4 (renamed 2026-10-17, ranges unchanged) | LOCKED 2026-10-15 |
| 42 | Tramps & walls | Graduated coins only. Users place **single-sided concentrated v4 LP ranges** via the `TrampWallManager` periphery: **tramp** = quote-only range strictly below price (support), **wall** = token-only range strictly above (resistance). **Pure limit orders, no yield** (pool LP fee 0, no donation). Owner can cancel anytime (no hold); anyone can `pull` a fully crossed range immediately (proceeds to owner minus a keeper tip, default 0.1%, owner-settable max 1%). Only LockedLP and TrampWallManager may add liquidity (hook gate). | LOCKED 2026-10-16 |
| 43 | Launch modes (v2) | Creator picks at launch: **TRENCH (0)**, **Easy = PVE (1)**: LoginGate login to buy, cap 1%→3.33%, partial fill, **crew tip** 0.777% of sell proceeds only when realized profit > tunable threshold (default **0.5% of mcap** at sale; owner-settable 0.1%–5%, snapshotted) → holders claim pool (replaces the 77% profit tax; 7-min window, 0.25% per-buy and 0.5% sell caps removed), First BOOST ≤1.2% locked to graduation; **Hard = PVP (2)**: no login, cap 3.33%→7.77%, partial fill, no max buy, First BOOST ≤3.33%, no crew tip / lock. All rules off at graduation | LOCKED 2026-10-23 |

---

## 1. Product / Chain

### Name
- **DISCIPLE** (formerly ANYPAIR).

### Scope
- **v0:** Robinhood Chain only.
- Mainnet and cross-chain pairing are deferred to **v2**.

### Surfaces
- Spot launchpad + gamified chart.
- Rocket game hosted on **disciple.vip**, owned by **DISCIPLE GAME** (UI/UX including nuke art).
- **DISCIPLE FLOW** owns backend and contracts.

### Explicit non-goals at launch
- No papertrade / leverage (deferred).
- No native protocol coin.
- External ERC-20 quotes only (no protocol-native quote asset beyond accepted ERC-20s that pass probe).

---

## 2. Architecture

### Chosen: Option B
- **External bonding curve**: single **steep Pump-style CPAMM** (constant-product virtual reserves).
- At graduation (**Outer Space $33,333 / 72% sold**, sold % pending): **same-transaction** Uniswap v4 migrate:
  - Initialize pool at curve-end **sqrtPriceX96** (**no price jump**).
  - Seed **full-range** liquidity with remaining **~28%** tokens + curve quote reserves (plus fee-escrowed quote).
  - Position owned forever by **LockedLP** (removeLiquidity disabled).
  - Pool **LP fee = 0**; **DiscipleHook** takes **1%** on swaps → FeeRouter **33/33/33/1** (same as curve). Justification: one fee path, no stacked pool+hook fees; LOCKED #16 pool-LP→treasury is N/A with 0 pool fee.
- **No migration pause or gap** between curve and AMM.

### Rejected for v0
- Architecture A (hook-as-curve) — deferred.
- Hybrid Pump-early / raise-late piecewise curve — superseded 2026-10-15 by single CPAMM.

### Curve parameters
| Parameter | Value |
|-----------|--------|
| Curve shape | **Single CPAMM** (Pump-style virtual reserves) |
| Start market cap | **$7,777** |
| Graduation market cap | **$33,333** (Outer Space) |
| Sold on curve | **72%** of supply (exact at graduation) |
| Total supply | **1,000,000** (no burn) |
| Mint policy | Fixed supply at launch; **no further mint** |
| Decimals | **18** (standard ERC-20) |
| Quote pricing | Any ERC-20; USD start/grad converted via quote price at launch |

### Wallet limits (bonding curve only)
- **Easy (PVE):** NET holding cap 1% → 3.33% of supply, linear in curve mcap $7,777 → $33,333 (pre-trade mcap).
- **Hard (PVP):** 3.33% → 7.77%, same formula.
- **TRENCH:** `walletCapBps` of total supply, snapshotted at launch. **Default 0 = no cap.** The protocol owner sets it with `Launchpad.setWalletCapBps(bps)` (0–10000, emits `WalletCapSet`). Coins launched before a change keep their snapshot (v1–v3 testnet coins keep the old fixed 7%).
- **Partial fill:** a buy over the cap fills up to the cap and refunds the rest (`BuyRefunded`); on the router USDG path the refund is swapped back to USDG. Room 0 reverts `WalletCap`. No max buy or max sell in any mode.
- Cap does **not** apply post-graduation.
- **No wallet exemptions.**

### Anti-snipe
- All modes. Buy-side sniper tax decays linearly from **99% → 0%** over **77 seconds** after launch; the First BOOST is exempt.
- After the window, total fee is only the protocol **1%** trade fee (+ creator tax).
- The tax is held in the curve's `snipeEscrow` (pair coin), outside `quoteReserve` and the price. At graduation it goes to LockedLP's locked **compound bucket** (`SnipeEscrowToLP`; Migration excludes it from the graduation floor). If the coin has not graduated `snipeEscrowTimeout` after launch (default **30 days**; `Launchpad.setSnipeEscrowTimeout`, 1–365 days, future launches only), anyone can call `releaseSnipeEscrow()` to send it to `FeeRouter.rewardsVault()`. No 70/30 split; no anti-snipe post-graduation (hook path).

### Token deployment
- Standard **CREATE** address generation.
- **No vanity** addresses.

---

## 3. Fees

### Base trade fee (1%)
Split of the 1% trade fee:

| Share | Destination | Notes |
|-------|-------------|--------|
| **33%** | Creator | Accrues on-chain; pull/claim anytime |
| **33%** | LP lock (quote) | Auto-add into LP each trade |
| **33%** | Treasury | Auto-push each trade |
| **1%** | Referral leftover | To referrer if present; else to treasury |

*(Percentages above are shares of the 1% fee, not of notional.)*

### Optional creator tax
- Default: **0%**.
- Optional at launch: up to **≤ 7%**.
- **Immutable at launch** (set once; cannot change later).
- Applied **on top of** the 1% protocol trade fee.

### Fee mechanics
| Stream | Behavior |
|--------|----------|
| Creator fees | Accrue on-chain; **claim anytime** |
| Treasury fees | **Auto-push** on each trade |
| LP-lock quote | Curve phase: **escrowed** in LockedLP on each trade, added to the locked position at graduation |
| Post-graduation LP fees | Pool LP fee is **0**; the hook's 33% LP share is **auto-compounded in batches into the locked full-range position** (added once the matched amount reaches 0.1% of position liquidity; ≤ 0.5% per 60 s window, one add per block) |

### LP at graduation
- LP is **permanently locked**.
- Seeded with the max matched amounts at the curve-end price; unpaired quote (≈15.6% of the raise) → the coin's **compound quote bucket** (`GraduationLeftover`), compounded into the locked position as buy-side token fees arrive.
- The position earns no pool fees (pool LP fee 0); `collectFees` is a no-op.
- **Remove-liquidity is not allowed.**

---

## 4. Referrals

### Attribution (first-touch, forever)
1. User opens a **referral link**.
2. Creates / links an **account**.
3. Completes a **USDG deposit ≥ $10**.

After that path, the referrer is locked to that wallet for life (first-touch).

### Rules
- **Same-wallet self-referral blocked only** (other cross-wallet referral is allowed under first-touch rules).
- Referrer fees **accrue** and can be **claimed anytime**.

### KOL / referrer economics
| Case | Payout |
|------|--------|
| Trades by referred wallet | Leftover **1% of the trade fee** on that wallet’s trades (lifetime) |
| Coins created by referred wallet | **3% of creator fees** on those coins, composed as: leftover **1% of fee** on those trades to KOL **+ 2% of the creator’s 33% share** |

---

## 5. Launch / UX

### Who can launch
- **Permissionless** — anyone can launch.

### Metadata
| Field | At launch | Post-launch update |
|-------|-----------|--------------------|
| Image | **Required** | Allowed |
| Name | **Required** | **Locked** (not updatable) |
| Ticker | **Required** | **Locked** (not updatable) |
| Description | Optional | Allowed |
| Socials | Optional | Allowed |

Style target: Flaunch-like required set (image + name + ticker).

### Ownership
- Transferable **anytime**.
- **Multi-hop** transfers OK.
- Transfer moves the **full pack**: metadata rights + fee claim rights + creator tax rights.

### Optional creator buy
- Allowed in the **same launch transaction**.
- Cap ("First BOOST max", `Launchpad.firstBoostMaxBps(mode)`): **Easy 1.2%**, **Hard 3.33%**, **TRENCH `creatorBuyMaxBps`** — default 0.77%, set by the protocol owner via `Launchpad.setCreatorBuyMaxBps` (emits `CreatorBuyMaxSet`), ceiling 7%; per-coin snapshot `creatorBuyMaxBpsOf(token)`. Larger amounts partial-fill.
- Exempt from the holding cap for that buy only (counts in NET afterwards) and from the sniper tax.
- **Easy:** the First BOOST tokens are locked until graduation (enforced in `Token._update` for the original creator); later buys are free.
- Can be paid in USDG via `DiscipleRouter.launchWithUsdg` (router-only `Launchpad.launchFor`); not a session-key action.

### Deposits, gas, MEV, liveness
| Topic | Rule |
|-------|------|
| Approvals | One deposit approval |
| Gas | User pays gas; **no gas sponsorship** |
| MEV | **Deadline + minAmountOut** only |
| Pause | **No pause** — curves and graduated pools are always live |

---

## 6. Quotes / Probe

### Quote policy
- **Any ERC-20** that passes the probe.
- **No curated allowlist.**

### Probe behavior
| Outcome | Condition |
|---------|-----------|
| Hard reject | Honeypot or fee-on-transfer (FoT) |
| Soft warn | Thin depth |
| Always pass | **WETH**, **USDG** |

### Seeding
- The **curve seeds LP** (not a maker/creator quote deposit).
- Thin-depth pairs receive **curve modifications** so seeding remains efficient.

---

## 7. Governance / Ops

### Treasury
- Controlled by **multisig**.
- Team / foundation **may change** the treasury address.

### Contracts
- **Upgradeable** behind team / foundation multisig.
- **No timelock.**

### Account (Privy)
- Full Privy stack: **X + wallet** (embedded and external).
- In-app **USDG cash balance**.

### Deposit / withdraw (v0)
| Action | Rule |
|--------|------|
| Deposit | **USDG only**; other EVM assets deferred |
| Withdraw | **USDG on Robinhood Chain only** |

---

## 8. Data / Chart

### Indexing
- **Own Robinhood Chain indexer** for trades, market cap, and price impact.
- **DexScreener** optional as a share link only (not primary source of truth).

### Nuke tiers (sell price impact)
Owned visually by **DISCIPLE GAME**. Tiers by sell price impact:

| Impact | Nuke tier |
|--------|-----------|
| &lt; 2% | PUFF |
| 2–5% | Grenade |
| 5–12% | Bunker buster |
| 12–25% | Cruise missile |
| 25–50% | Nuke |
| ≥ 50% | Atom bomb |

---

## 9. Tier Ladder (biblically ascending)

Market-cap **ranges** for the gamified chart / rocket progression.  
Re-priced 2026-10-15 so **graduation = $33K** (the open of **Outer Space**; tiers renamed 2026-10-17 to the official ladder in disciple-brand/LEXICON.md §4 and web/lib/flight/tiers.ts, ranges unchanged). **Verified tier badges are off-chain/indexer-only** (no on-chain tier hooks); Launchpad emits `LaunchTierContext` + `Launched` for indexers. LOCKED 2026-10-15. Pre-grad tiers span $7K→$33K evenly; post-grad grows roughly geometrically to Seventh Heaven. Ranges are contiguous and non-overlapping (half-open: tier owns `[lo, hi)` except Seventh Heaven which is closed at the top).

| Tier name | Market cap range |
|-----------|------------------|
| **Launch Pad** | **$7K–$12K** |
| **Ozone** | **$12K–$18K** |
| **Stratosphere** | **$18K–$25K** |
| **Kármán Line** | **$25K–$33,333** |
| **Outer Space** *(graduation at $33,333)* | **$33,333–$55K** |
| **Firmament** | **$55K–$100K** |
| **Morning Stars** | **$100K–$333K** |
| **Heavenly Host** | **$333K–$777K** |
| **The Moon** | **$777K–$1.2M** |
| **Uranus** | **$1.2M–$3.3M** |
| **Limbo** | **$3.3M–$7.7M** |
| **Gates of Heaven** | **$7.7M–$33M** |
| **Throne Room** | **$33M–$77M** |
| **Cherubim** | **$77M–$120M** |
| **Seraphim** | **$120M–$777M** |
| **Aether** | **$777M–$1.2B** |
| **Empyrean** | **$1.2B–$3.3B** |
| **Seventh Heaven** | **$3.3B–$7.77B** |

Graduation occurs at the open of **Outer Space ($33,333)**.

---

## 10. Deferred (not v0)

The following are explicitly **out of scope** for v0. Do not implement against this constitution until a later revision unlocks them:

| Item | Notes |
|------|--------|
| Papertrade | Deferred |
| Circuit | Deferred |
| Cross-chain pairing | Deferred to v2 |
| Gas sponsorship | Deferred (user pays gas in v0) |
| Any-EVM deposit routing | Deferred (USDG-only deposits in v0) |
| Architecture A (hook-as-curve) | Deferred; v0 is Option B |
| Mainnet / non–Robinhood Chain | Deferred to v2 |
| Native protocol coin | Not at launch |
| Leverage | Deferred with papertrade |

---

## Agent ownership

| Concern | Owner |
|---------|--------|
| Backend, contracts, protocol economics, indexer | **DISCIPLE FLOW** |
| Game UI/UX, rocket game on disciple.vip, nuke art | **DISCIPLE GAME** |

---

## Document control

- **Locked as of:** 2026-10-15  
- **2026-10-23:** LOCKED #7 supply 7B → **1,000,000** (lee sign-off; no burn). LOCKED #6 endpoints $7K→$33K → **$7,777→$33,333**; Kármán Line / Outer Space boundary moved to $33,333 so Outer Space = graduation. Sold % still open.
- **Revisions this date:** LOCKED #5–#6, #9, #17, #41 — curve $7K→$33K CPAMM; anti-snipe 77.7%→0% (snipe destination later revised to 70% RewardsVault / 30% treasury, see #9); real v4 same-tx migrate (no-jump, LockedLP owns LP); re-priced tier ladder.  
- **Scope label:** v0 / Robinhood Chain  
- **Revisions 2026-10-15 (tramps & walls):** LOCKED #9/#27 creator launch buy anti-snipe exempt; #16 LP share split 1/3 donate to in-range LPs + 2/3 LockedLP (superseded 2026-10-16: no donation); new #42 tramps & walls.  
- **Revisions 2026-10-16 (no LP yield):** #16 donation removed, full 33% LP share → LockedLP; #42 tramps/walls are pure limit orders (no fees, no claim, no min hold), keeper-tipped `pull`, hook LP-add gate (LockedLP + TWM only).  
- **Revisions 2026-10-16 (audit fixes):** #11 leftover priority spelled out; #15/#16 LP share described as held pending compound; #29 router impact cap; graduation leftover quote → treasury.  
- **Revisions 2026-10-16 (LP auto-compound):** #16 LP share is auto-compounded per trade into the locked full-range position (threshold 0.005% of position liquidity, cap 2%, 3% price-deviation skip, permissionless `flush`; **superseded on PR #75:** threshold 0.1%, cap 0.5% per 60 s window + one add per block, batched). Graduation leftover quote → compound quote bucket (was treasury).  
- **Revisions 2026-10-17 (PR #75):** #41/§9 tier names → official ladder (Ozone, Stratosphere, Kármán Line, Outer Space = graduation, Morning Stars, Heavenly Host, The Moon, Uranus, Limbo, Gates of Heaven; ranges unchanged; `Constants.PEARLY_GATES_MCAP_USD` → `OUTER_SPACE_MCAP_USD`, `TIER_*` renamed). #35 non-upgradeable, redeploy-only. #12 creator tax curve-only. #11/#16 compound numbers: 0.1% minimum, 0.5% per 60 s cap, one add per block, batched.  
- **Revisions 2026-10-23 (mode rules v2, Maker lee):** #8 per-mode caps growing with mcap + partial fill; #9 sniper tax 99%→0 over 77 s (was 60 s in the first draft) into `snipeEscrow` → LockedLP compound bucket at graduation / RewardsVault after 30 days (tunable); #27 per-mode First BOOST max + Easy creator lock; new #43 launch modes (Easy crew tip replaces the 77% profit tax). Requires the combined testnet redeploy (with paymaster #106 + 6-dec USDG). Needs AUDIT.  
- **Change policy:** Treat the LOCKED table as authoritative. New decisions require an explicit unlock / revision of this constitution; do not silently override LOCKED rows.

*End of DISCIPLE Protocol Constitution.*


### Revision 2026-10-15 (defaultQuote / pool fee / tiers)
- LOCKED #16: pool LP fee 0; 1% hook only.
- LOCKED #31: defaultQuote=STRATEGY; custom quote via probe.
- Verified tiers: offchain/indexer; emit LaunchTierContext.
- **Revisions 2026-10-15 (snipe split):** LOCKED #9 — anti-snipe tax now 70% community RewardsVault / 30% treasury (was 100% LP lock). Requires FeeRouter redeploy (core).
- **Revisions 2026-10-15 (wallet cap):** LOCKED #8 — the fixed 7% curve wallet cap becomes protocol-owner-settable `walletCapBps` (default 0 = no cap, range 0–10000), snapshotted per coin. Creator-buy cap (#27) unchanged. Requires Launchpad + CurveDeployer (+ AntiSnipe, add-ons) redeploy.
- **Revisions 2026-10-15 (creator buy cap):** LOCKED #27 — creator-buy cap is now protocol-owner-settable `creatorBuyMaxBps` (default 0.77%, ceiling 7%), snapshotted per coin. Requires Launchpad redeploy (core).

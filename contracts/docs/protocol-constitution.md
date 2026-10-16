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
| 6 | Curve levels | Start mcap **$7K** → graduation **$33K** (Pearly Gates); single CPAMM hits grad exactly at 72% sold | LOCKED 2026-10-15 |
| 7 | Supply on curve | **~72%** sold on curve; **7B** total supply; fixed at launch, no further mint; **18 decimals** ERC-20 | LOCKED |
| 8 | Wallet cap | Per-wallet holding cap on the bonding curve only (not post-grad) = **`Launchpad.walletCapBps`** of supply — default **0 (no cap)**, protocol-owner-settable 0–10000 bps (event `WalletCapSet`), **snapshotted per coin at launch** (`walletCapBpsOf(token)`, immutable in the curve; changes affect future coins only); when set, **no wallet exemptions** (rev. 2026-10-15, was fixed 7%) | LOCKED 2026-10-15 |
| 9 | Anti-snipe | **77.7% → 0%** buy-side fee over **7s** (after 7s only protocol 1% remains); snipe fee **portion above the 1% protocol fee** routes **70% to the community RewardsVault / 30% to treasury** (not 33/33/33/1; rev. 2026-10-15, was 100% LP lock). **Creator launch buy (≤ creatorBuyMaxBps, default 0.77%, same tx) is exempt** — pays only the 1% protocol fee (+ own creator tax) | LOCKED 2026-10-15 |
| 10 | Token address | Standard **CREATE**; no vanity | LOCKED |
| 11 | Trade fee | **1%** trade fee → **33%** creator / **33%** lock quote into LP / **33%** treasury / **1%** referral leftover (to treasury if no referrer) | LOCKED |
| 12 | Creator tax | Optional; default **0%**, optional **≤7%**, **immutable at launch**; on top of 1% fee | LOCKED |
| 13 | Creator fees | Accrue on-chain; **pull/claim anytime** | LOCKED |
| 14 | Treasury fees | **Auto-push** each trade | LOCKED |
| 15 | LP-lock quote | **Auto-add** into LP each trade | LOCKED |
| 16 | Post-grad LP fees | v4 **pool LP fee = 0**; **1% DiscipleHook only**. Split 33 creator / 33 LP / 33 treasury / 1 referral; the **full 33% LP share is auto-added to LockedLP** (permanent full-range). **No in-range donation** (`PoolManager.donate` removed 2026-10-16): tramps/walls earn no yield. Total fee stays 1%. | LOCKED 2026-10-16 |
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
| 27 | Creator buy | Optional creator buy in launch tx; max **`Launchpad.creatorBuyMaxBps`** of supply — default **0.77%** (77 bps), protocol-owner-settable (never the coin creator), hard ceiling **7%** (700 bps), snapshotted per coin at launch (changes affect future coins only); **anti-snipe exempt** (1% protocol fee only) | LOCKED 2026-10-15 |
| 28 | Deposits / gas | One deposit approval; user pays gas; **no gas sponsorship** | LOCKED |
| 29 | MEV protection | **Deadline + minAmountOut** only | LOCKED |
| 30 | Pause | **No pause** — curves and graduated pools always live | LOCKED |
| 31 | Quotes | **defaultQuote = STRATEGY** (RH chain; owner/multisig settable). `launchCoin`/`launch` with `quote=address(0)` uses defaultQuote; **custom ERC-20 quote** still allowed if it passes probe; no curated allowlist beyond always-pass (STRATEGY/WETH/USDG) | LOCKED 2026-10-15 |
| 32 | Probe | Hard reject honeypot / FoT only; thin depth soft warn; **WETH / USDG always pass** | LOCKED |
| 33 | LP seeding | Curve seeds LP (not maker/creator quote deposit); thin-depth pairs get curve mods for efficient seeding | LOCKED |
| 34 | Treasury | Multisig; team/foundation can change address | LOCKED |
| 35 | Contracts | Upgradeable behind team/foundation multisig; **no timelock** | LOCKED |
| 36 | Account | Full Privy — X + wallet (embedded + external); USDG cash balance | LOCKED |
| 37 | Deposit | **USDG only** in v0; other EVM assets deferred | LOCKED |
| 38 | Withdraw | USDG on **Robinhood Chain only** | LOCKED |
| 39 | Data / chart | Own RH indexer for trades, mcap, impact; DexScreener optional share link | LOCKED |
| 40 | Nuke tiers | By sell price impact (GAME owns art): &lt;2% brake; 2–5% grenade; 5–12% bunker buster; 12–25% cruise missile; 25–50% nuke; ≥50% atom bomb | LOCKED |
| 41 | Tier ladder | Biblically ascending mcap **ranges** from Launch Pad ($7K–$12K) through Seventh Heaven ($3.3B–$7.77B); Pearly Gates = $33K graduation — see detailed section | LOCKED 2026-10-15 |
| 42 | Tramps & walls | Graduated coins only. Users place **single-sided concentrated v4 LP ranges** via the `TrampWallManager` periphery: **tramp** = quote-only range strictly below price (support), **wall** = token-only range strictly above (resistance). **Pure limit orders, no yield** (pool LP fee 0, no donation). Owner can cancel anytime (no hold); anyone can `pull` a fully crossed range immediately (proceeds to owner minus a keeper tip, default 0.1%, owner-settable max 1%). Only LockedLP and TrampWallManager may add liquidity (hook gate). | LOCKED 2026-10-16 |

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
- At graduation (**Pearly Gates $33K / 72% sold**): **same-transaction** Uniswap v4 migrate:
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
| Start market cap | **$7,000** |
| Graduation market cap | **$33,000** (Pearly Gates) |
| Sold on curve | **72%** of supply (exact at graduation) |
| Total supply | **7,000,000,000** |
| Mint policy | Fixed supply at launch; **no further mint** |
| Decimals | **18** (standard ERC-20) |
| Quote pricing | Any ERC-20; USD start/grad converted via quote price at launch |

### Wallet limits (bonding curve only)
- Per-wallet cap while on the bonding curve = `walletCapBps` of total supply, snapshotted at launch. **Default 0 = no cap.** The protocol owner sets it with `Launchpad.setWalletCapBps(bps)` (0–10000, emits `WalletCapSet`). Coins launched before a change keep their snapshot (v1–v3 testnet coins keep the old fixed 7%).
- Cap does **not** apply post-graduation.
- **No wallet exemptions.**

### Anti-snipe
- Buy-side fee decays from **77.7% → 0%** over **7 seconds** after launch.
- After the window, total fee is only the protocol **1%** trade fee (no residual snipe fee).
- The anti-snipe fee portion (**above** the protocol 1%) routes **70% to the community `RewardsVault`** (owner-settable on FeeRouter via `setRewardsVault`; accrues for later USDG/rewards distribution) and **30% to treasury** (incl. rounding remainder) — it does **not** use the 33/33/33/1 trade-fee split (`FeeRouter.routeSnipeFee`). If no vault is set, 100% goes to treasury. No anti-snipe exists post-graduation (hook path).

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
| LP-lock quote | **Auto-add** into LP on each trade |
| Post-graduation LP fees | **100% to treasury** |

### LP at graduation
- LP is **permanently locked**.
- Fee collection is allowed.
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
- Cap: **max `creatorBuyMaxBps` of supply** — default 0.77%, set by the protocol owner via `Launchpad.setCreatorBuyMaxBps` (emits `CreatorBuyMaxSet`), ceiling 7%; per-coin snapshot `creatorBuyMaxBpsOf(token)`.

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
| &lt; 2% | Brake |
| 2–5% | Grenade |
| 5–12% | Bunker buster |
| 12–25% | Cruise missile |
| 25–50% | Nuke |
| ≥ 50% | Atom bomb |

---

## 9. Tier Ladder (biblically ascending)

Market-cap **ranges** for the gamified chart / rocket progression.  
Re-priced 2026-10-15 so **Pearly Gates = $33K graduation**. **Verified tier badges are off-chain/indexer-only** (no on-chain tier hooks); Launchpad emits `LaunchTierContext` + `Launched` for indexers. LOCKED 2026-10-15. Pre-grad tiers span $7K→$33K evenly; post-grad grows roughly geometrically to Seventh Heaven. Ranges are contiguous and non-overlapping (half-open: tier owns `[lo, hi)` except Seventh Heaven which is closed at the top).

| Tier name | Market cap range |
|-----------|------------------|
| **Launch Pad** | **$7K–$12K** |
| **Limbo** | **$12K–$18K** |
| **Ascension** | **$18K–$25K** |
| **Narrow Gate** | **$25K–$33K** |
| **Pearly Gates** *(graduation at $33K)* | **$33K–$55K** |
| **Firmament** | **$55K–$100K** |
| **Angels** | **$100K–$333K** |
| **Archangels** | **$333K–$777K** |
| **Heavenly Host** | **$777K–$1.2M** |
| **Morning Stars** | **$1.2M–$3.3M** |
| **Virtues** | **$3.3M–$7.7M** |
| **Dominions** | **$7.7M–$33M** |
| **Throne Room** | **$33M–$77M** |
| **Cherubim** | **$77M–$120M** |
| **Seraphim** | **$120M–$777M** |
| **Aether** | **$777M–$1.2B** |
| **Empyrean** | **$1.2B–$3.3B** |
| **Seventh Heaven** | **$3.3B–$7.77B** |

Graduation occurs at the open of **Pearly Gates ($33K)**.

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
- **Revisions this date:** LOCKED #5–#6, #9, #17, #41 — curve $7K→$33K CPAMM; anti-snipe 77.7%→0% (snipe→100% LP); real v4 same-tx migrate (no-jump, LockedLP owns LP); re-priced tier ladder.  
- **Scope label:** v0 / Robinhood Chain  
- **Revisions 2026-10-15 (tramps & walls):** LOCKED #9/#27 creator launch buy anti-snipe exempt; #16 LP share split 1/3 donate to in-range LPs + 2/3 LockedLP; new #42 tramps & walls.  
- **Revisions 2026-10-16 (no LP yield):** #16 donation removed, full 33% LP share → LockedLP; #42 tramps/walls are pure limit orders (no fees, no claim, no min hold), keeper-tipped `pull`, hook LP-add gate (LockedLP + TWM only).  
- **Change policy:** Treat the LOCKED table as authoritative. New decisions require an explicit unlock / revision of this constitution; do not silently override LOCKED rows.

*End of DISCIPLE Protocol Constitution.*


### Revision 2026-10-15 (defaultQuote / pool fee / tiers)
- LOCKED #16: pool LP fee 0; 1% hook only.
- LOCKED #31: defaultQuote=STRATEGY; custom quote via probe.
- Verified tiers: offchain/indexer; emit LaunchTierContext.
- **Revisions 2026-10-15 (snipe split):** LOCKED #9 — anti-snipe tax now 70% community RewardsVault / 30% treasury (was 100% LP lock). Requires FeeRouter redeploy (core).
- **Revisions 2026-10-15 (wallet cap):** LOCKED #8 — the fixed 7% curve wallet cap becomes protocol-owner-settable `walletCapBps` (default 0 = no cap, range 0–10000), snapshotted per coin. Creator-buy cap (#27) unchanged. Requires Launchpad + CurveDeployer (+ AntiSnipe, add-ons) redeploy.
- **Revisions 2026-10-15 (creator buy cap):** LOCKED #27 — creator-buy cap is now protocol-owner-settable `creatorBuyMaxBps` (default 0.77%, ceiling 7%), snapshotted per coin. Requires Launchpad redeploy (core).

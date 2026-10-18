---
title: Parameters
slug: /docs/reference/parameters
section: Reference
---
# Parameters

Every number in one place. Values are for the current testnet deploy unless marked.

## Rocket

| Parameter | Value |
|---|---|
| Total supply | 7,000,000,000, fixed, 18 decimals |
| Mint after launch | None |
| Name and call sign | Locked at launch |
| Address | Standard (no vanity) |

## Bonding curve

| Parameter | Value |
|---|---|
| Curve type | Constant product, virtual reserves |
| Start market cap | $7,000 |
| Graduation market cap | $33,000 (Outer Space) |
| Sold on the curve | 72% (5.04B) |
| Locked forever in the Uniswap v4 LP | 28% (1.96B) + base raised |
| Base raised at graduation (USDG base) | ≈ $10,943, net of fees |

## Fees

| Parameter | Value |
|---|---|
| Trade fee | 1% of every BOOST and DUMP |
| Split of the trade fee | 33% creator · 33% locked liquidity · 33% treasury · 1% referrer |
| Graduated pool LP fee | 0% |
| Creator tax | 0–7%, set at launch, curve trades only |
| Anti-snipe fee | 77.7% → 0% over 7 seconds, BOOSTs only, curve only |
| Anti-snipe split | 70% rewards vault · 30% treasury |
| Creator launch buy | Exempt from anti-snipe |

## Limits

| Parameter | Value |
|---|---|
| Creator launch buy cap | 0.77% of supply (team-settable, max 7%) |
| Protocol wallet cap (curve) | None by default (team-settable 0–100%) |
| Router max price impact | 50% per swap (team-settable 1–1,000%) |
| Keeper tip (tramps and walls) | 0.1% (max 1%) |
| Pseudonymous launch fee | $0.25 USDG on testnet (max $5) |

## Referrals

| Parameter | Value |
|---|---|
| Lock-in | Link → sign in → $10+ USDG deposit, first link wins, for life |
| Referrer earns on a referred wallet's trades | 1% of the trade fee (0.01% of the trade), unless the launcher's referrer comes first |
| On rockets the referred wallet launches | 1% of the trade fee on every trade + 2% of the creator's share |
| Self-referral | Same wallet blocked |

## Launch modes (coming, PR #75, values may change)

| | PvE | PvP | Trench Warfare |
|---|---|---|---|
| Wallet cap | 1% | 4% → 12% | None |
| Max BOOST | 0.25% for 7 min | 3.33% | None |
| Max DUMP | 0.5% | None | None |
| Profit tax | 0.777% above 1.77× cost | None | None |
| Login to BOOST | Yes | No | No |

## Altitude

18 tiers from $7K to $7.77B. See [Altitude and tiers](/docs/game/tiers).

## Bombs

PUFF < 2% · GRENADE 2–5% · BUNKER 5–12% · CRUISE 12–25% · NUKE 25–50% · ATOM ≥ 50% price impact.

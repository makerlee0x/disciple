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
| Total supply | 1,000,000, fixed, 18 decimals |
| Mint after launch | None |
| Name and call sign | Locked at launch |
| Address | Standard (no vanity) |

## Bonding curve

| Parameter | Value |
|---|---|
| Curve type | Constant product, virtual reserves, steep finish |
| Start market cap | $3,333 |
| Graduation market cap | $33,333 (Outer Space) |
| Sold on the curve | 84.24% (842,400) |
| Locked forever in the Uniswap v4 LP | 15.76% (157,600) + base raised (pool ≈ $5.25K) |
| Base raised at graduation (USDG base) | ≈ $6,455, net of fees |

## Fees

| Parameter | Value |
|---|---|
| Trade fee | 1% of every BOOST and DUMP |
| Split of the trade fee | 33% creator · 33% locked liquidity · 33% treasury · 1% referrer |
| Graduated pool LP fee | 0% |
| Creator tax | 0–7%, set at launch, curve trades only |
| Anti-snipe fee | 99% → 0% over 77 seconds, BOOSTs only, curve only |
| Anti-snipe destination | Escrow → locked LP at graduation, or RewardsVault after 30 days without graduating |
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

## Launch modes (coming with the next redeploy, mode rules v2)

| | Easy (PvE) | Hard (PvP) | Trench Warfare |
|---|---|---|---|
| Wallet cap | 1% → 3.33% with market cap | 3.33% → 7.77% | None |
| Over-cap BOOST | Partial fill + refund | Partial fill + refund | — |
| Max BOOST / DUMP | None | None | None |
| Crew tip | 0.777% when profit > 0.5% of market cap | None | None |
| First BOOST max | 1.2%, locked to graduation | 3.33% | 0.77% |
| Login to BOOST | Yes | No | No |
| Sniper tax | 99% → 0 over 77 s, escrowed: locked LP at graduation, RewardsVault after 30 days if not | same | same |

## Altitude

18 tiers from $3.3K to $7.77B. See [Altitude and tiers](/docs/game/tiers).

## Bombs

PUFF < 2% · GRENADE 2–5% · BUNKER 5–12% · CRUISE 12–25% · NUKE 25–50% · ATOM ≥ 50% price impact.

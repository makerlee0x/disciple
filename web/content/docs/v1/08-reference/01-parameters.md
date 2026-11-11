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

## The starting price path

| Parameter | Value |
|---|---|
| How the price moves | Each buy costs a little more than the last, with a steep finish near orbit |
| Value at the start | $3,333 |
| Value when the rocket reaches orbit | $33,333 (the Outer Space tier) |
| Sold on the starting price path | 84.24% (842,400) |
| Locked forever in the Uniswap v4 LP | 15.76% (157,600) + base raised (pool ≈ $5.25K) |
| Base raised when the rocket reaches orbit (USDG base) | ≈ $6,455, net of fees |

## Fees

| Parameter | Value |
|---|---|
| Trade fee | 1% of every BOOST and DUMP |
| Split of the trade fee | 33% creator · 33% locked liquidity · 33% treasury · 1% referrer |
| Extra fee charged by the Uniswap pool after orbit | 0% (the 1% fee still applies) |
| Creator tax | 0–7%, set at launch, curve trades only |
| Sniper tax | 99% at launch, 25% at 1s, 3% at 2s, 0 from 7s (one step per second), BOOSTs only, curve only |
| Sniper tax destination | Locked liquidity when the rocket reaches orbit · the rewards vault if it has not reached orbit in 30 days |
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
| Wallet cap | 1% → 3.33% as the rocket's value climbs | 3.33% → 7.77% | None |
| Over-cap BOOST | Partial fill + refund | Partial fill + refund | — |
| Max BOOST / DUMP | None | None | None |
| Crew tip | 0.777% when profit is above 0.5% of the rocket's value | None | None |
| First BOOST max | 1.2%, locked until the rocket reaches orbit | 3.33% | 0.77% |
| Login to BOOST | Yes | No | No |
| Sniper tax | 99% → 0 over 7 s (per-second table), held aside: locked liquidity when the rocket reaches orbit, rewards vault after 30 days if it has not | same | same |

## Altitude

Altitude is how high a rocket's value has climbed, shown as 18 named tiers from $3,333 to $7.77 billion. See [Altitude and tiers](/docs/game/tiers).

## Bombs

PUFF < 2% · GRENADE 2–5% · BUNKER 5–12% · CRUISE 12–25% · NUKE 25–50% · ATOM ≥ 50% price impact.

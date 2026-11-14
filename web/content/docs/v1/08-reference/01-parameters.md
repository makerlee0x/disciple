---
title: Parameters
slug: /docs/reference/parameters
section: Reference
---
# Parameters

Every number in one place.

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
| Split of the trade fee | 33% creator · 33% locked liquidity · 33% treasury · 1% other |
| Extra fee charged by the Uniswap pool after orbit | 0% (the 1% fee still applies) |
| Creator tax | 0–7%, set at launch, before orbit only |
| Sniper tax | 99% at launch, 25% at 1 second, 3% at 2 seconds, nothing from 7 seconds (one step per second). BOOSTs only, before orbit only. |
| Sniper-tax window | 12 days after launch |
| Where the sniper tax goes | Locked liquidity if the rocket reaches orbit within 12 days · community rewards if it doesn't |
| Where the liquidity share of fees before orbit goes | Locked liquidity if the rocket reaches orbit within 12 days · community rewards if it doesn't |
| Creator launch buy | Doesn't pay the sniper tax |

## Limits

| Parameter | Value |
|---|---|
| Smallest BOOST | $3 |
| Creator launch buy (First BOOST) | Easy 1.2% · Hard 3.33% · Expert 7.77% (the team can lower the Expert limit, not raise it) |
| Extra holding limit on every new rocket | None (the team can set one, 0–100%) |
| Router max price impact | 50% per trade (team can set 1–1,000%) |
| Private launch fee | Set by the team, paid in USDG, up to $5 |

## Launch modes

| | Easy | Hard | Expert |
|---|---|---|---|
| Holding limit | 1% → 3.33% as the rocket's value climbs | 3.33% → 7.77% | None |
| BOOST over the limit | Partly filled, the rest refunded | Partly filled, the rest refunded | — |
| Biggest single BOOST or DUMP | No limit | No limit | No limit |
| Crew tip | 0.777% when profit is above 0.5% of the rocket's value | None | None |
| First BOOST max | 1.2%, locked until the rocket reaches orbit | 3.33% | 7.77% |
| Sign-in to BOOST | Yes | No | No |
| Sniper tax | Same in every mode: 99% falling to 0 over 7 seconds | Same | Same |

## Altitude

Altitude is how high a rocket's value has climbed, shown as 18 named tiers from $3,333 to $7.77 billion. See [Altitude and tiers](/docs/game/tiers).

## Bombs

PUFF < 2% · GRENADE 2–5% · BUNKER 5–12% · CRUISE 12–25% · NUKE 25–50% · ATOM ≥ 50% price impact.

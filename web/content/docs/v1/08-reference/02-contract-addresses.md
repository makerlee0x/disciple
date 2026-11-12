---
title: Contract addresses
slug: /docs/reference/contracts
section: Reference
---
# Contract addresses

DISCIPLE runs on Robinhood Chain. The addresses of its contracts will be published on this page, with links to the block explorer. [CONFIRM: FLOW — add the verified addresses and explorer links.]

## DISCIPLE

The DISCIPLE contracts are Launchpad, CurveDeployer, DiscipleHook, DiscipleRouter, Migration, LockedLP, FeeRouter, CurveFeeVault (the fee vault), RewardsVault (community rewards), QuotePricer, QuoteProbe, TrampWallManager, AnonLauncher and MarketLens.

Each rocket also has its own BondingCurve. Find it from the Launchpad (`curveOf(token)`) or on the rocket's page.

## Uniswap v4

Rockets that reach orbit trade in Uniswap v4 pools. The DISCIPLE app doesn't route trades through Uniswap's UniversalRouter. One-tap trades use Uniswap's Permit2 to sign each trade. Their addresses will be listed here with DISCIPLE's.

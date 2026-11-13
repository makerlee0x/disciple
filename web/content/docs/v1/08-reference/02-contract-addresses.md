---
title: Contracts
slug: /docs/reference/contracts
section: Reference
---
# Contracts

DISCIPLE runs on Robinhood Chain. These are the contracts it uses.

## DISCIPLE

The DISCIPLE contracts are Launchpad, CurveDeployer, DiscipleHook, DiscipleRouter, Migration, LockedLP, FeeRouter, CurveFeeVault (the fee vault), RewardsVault (community rewards), QuotePricer, QuoteProbe, TrampWallManager, AnonLauncher and MarketLens.

Each rocket also has its own BondingCurve. Find it from the Launchpad (`curveOf(token)`) or on the rocket's page.

## Uniswap v4

Rockets that reach orbit trade in Uniswap v4 pools. The DISCIPLE app doesn't route trades through Uniswap's UniversalRouter. One-tap trades use Uniswap's Permit2 to sign each trade.

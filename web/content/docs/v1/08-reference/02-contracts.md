---
title: Contracts
slug: /docs/reference/contracts
section: Reference
---
# Contracts

DISCIPLE runs on Robinhood Chain mainnet (chain id 4663).

## DISCIPLE

| Contract | Address |
|---|---|
| Launchpad | [`0xe43F360DC65C9Ba1B7a835BDaa10Fb31f6DC52E5`](https://explorer.robinhood.com/address/0xe43F360DC65C9Ba1B7a835BDaa10Fb31f6DC52E5) |
| DiscipleHook | [`0xF681588d62C3cf2e8e0659887130fa7Ea35c6044`](https://explorer.robinhood.com/address/0xF681588d62C3cf2e8e0659887130fa7Ea35c6044) |
| DiscipleRouter | [`0xa689375C1980f2b5938d06659F4d9dC314ab3678`](https://explorer.robinhood.com/address/0xa689375C1980f2b5938d06659F4d9dC314ab3678) |
| Migration | [`0x0fCD7FE98Eed9234A1d1c2aAb6AEec210809747b`](https://explorer.robinhood.com/address/0x0fCD7FE98Eed9234A1d1c2aAb6AEec210809747b) |
| LockedLP | [`0xe3F8FeefF2ad0d6f4055cD90f91518C1331E1c4D`](https://explorer.robinhood.com/address/0xe3F8FeefF2ad0d6f4055cD90f91518C1331E1c4D) |
| FeeRouter | [`0x2EDf61eD533E57bBa79445472762de95DE8AE8DF`](https://explorer.robinhood.com/address/0x2EDf61eD533E57bBa79445472762de95DE8AE8DF) |
| CreatorFeeHarvest | [`0x65E6D7a4935c28036450121d7a608d071Ed388ba`](https://explorer.robinhood.com/address/0x65E6D7a4935c28036450121d7a608d071Ed388ba) |
| RewardsVault | [`0x187d88984f1dC461Fa53Ff6159186822bD3bb605`](https://explorer.robinhood.com/address/0x187d88984f1dC461Fa53Ff6159186822bD3bb605) |
| QuotePricer | [`0x95b6FeCef5E94254A4e676ADc6af91fDd70e0f27`](https://explorer.robinhood.com/address/0x95b6FeCef5E94254A4e676ADc6af91fDd70e0f27) |
| QuoteProbe | [`0x47134F86CE3b3F8aD72a9399006Eea99C4E1a5F6`](https://explorer.robinhood.com/address/0x47134F86CE3b3F8aD72a9399006Eea99C4E1a5F6) |
| CurveDeployer | [`0xC1610bBEd004128B1748E1BA4f338Ba82AFE94e9`](https://explorer.robinhood.com/address/0xC1610bBEd004128B1748E1BA4f338Ba82AFE94e9) |
| ReferralRegistry | [`0x189ea5a8130a05D0C1AFC1c871bB355FC8BF7aF4`](https://explorer.robinhood.com/address/0x189ea5a8130a05D0C1AFC1c871bB355FC8BF7aF4) |
| AnonLauncher | [`0x04860a3D09617270E9e6CD2D91A143D2F7556511`](https://explorer.robinhood.com/address/0x04860a3D09617270E9e6CD2D91A143D2F7556511) |
| MarketLens | [`0x9576996a4bd1700572a9D3bF5098fb6B5069bD06`](https://explorer.robinhood.com/address/0x9576996a4bd1700572a9D3bF5098fb6B5069bD06) |
| DisciplePermitForwarder | [`0x346e7ff1c9d088113a659b5b0ac2c2f4efd52b4b`](https://explorer.robinhood.com/address/0x346e7ff1c9d088113a659b5b0ac2c2f4efd52b4b) |

Each rocket gets its own BondingCurve and CurveFeeVault, made by the CurveDeployer at launch.

What each one does: [Contracts and admin](/docs/safety).

## Uniswap v4

Rockets in orbit trade in Uniswap v4 pools. One-tap trades sign through Uniswap's Permit2.

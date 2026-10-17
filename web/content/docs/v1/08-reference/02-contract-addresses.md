---
title: Contract addresses
slug: /docs/reference/contracts
section: Reference
---
# Contract addresses

**Robinhood Chain Testnet** (chain 46630). Deployed Oct 15, 2026. Source: `contracts/deployments/rh-testnet-46630.json`.

> These are testnet addresses. They will change at the next redeploy. Always check this page or the app. [CONFIRM: FLOW — refresh after the launch-modes redeploy; add verified explorer links.]

## DISCIPLE

| Contract | Address |
|---|---|
| Launchpad | `0x5537c8e1a329ea9628251caa602ca49bb8e45529` |
| CurveDeployer | `0x37427357b6d0db92137872d6b7d17c9cede72c40` |
| DiscipleHook | `0x065e6e6f391aeea6b11cba111d4a714c2f93c0c4` |
| DiscipleRouter | `0xf04f7d3b54f86cc5333e7e2302850b023c796e69` |
| Migration | `0xe561dfe17036635bd74f5eac5f81a19f8731cb5c` |
| LockedLP | `0x954c768562756c291c29cb14ec08604c2e00eb11` |
| FeeRouter | `0x50d039086f2fd46d200e5111f3915231042416e4` |
| AntiSnipe | `0x2738a2fa95b023e2ea91dd26f905cf43de586cea` |
| ReferralRegistry | `0xc0d538863c6e6ab1128c6149e173b55f77938478` |
| RewardsVault | `0xbd7cb15c0d8900dcabd6421439a47f5b163fd0c3` |
| QuotePricer | `0x0bc08f97e7e4669bf3760b3534f681cdff28961a` |
| QuoteProbe | `0xf5c09182091e527f0445ce065f7fc59d4b55cede` |
| TrampWallManager | `0xdd4aaacc95c19169ddd50991de64da28f053259f` |
| AnonLauncher | `0x57792df0ed8772fc6135e17c45099e9c06455e37` |
| MarketLens | `0x56b742ec5410996eac56b36c477ee9548c0caa9c` |

Each rocket also has its own BondingCurve. Find it from the Launchpad (`curveOf(token)`) or on the rocket's page.

## Test tokens

| Token | Address | Note |
|---|---|---|
| mUSDG | `0x25030Bff74764aD72b912276a603717DB1C00644` | Test USDG, priced at $1 |
| STRATEGY (test) | `0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3` | Default base. Testnet only. |

## Uniswap v4 (Robinhood Chain)

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Network

| | |
|---|---|
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |

## Mainnet

Not deployed. There's no date.

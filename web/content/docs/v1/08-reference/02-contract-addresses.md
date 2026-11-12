---
title: Contract addresses
slug: /docs/reference/contracts
section: Reference
---
# Contract addresses

**Robinhood Chain Testnet** (chain 46630).

> New contracts come with the testnet and mainnet redeploy. Addresses will be published after the redeploy. [CONFIRM: FLOW — refresh after the launch-modes redeploy; add verified explorer links.]

## DISCIPLE

Addresses will be published after the redeploy. The DISCIPLE contracts are Launchpad, CurveDeployer, DiscipleHook, DiscipleRouter, Migration, LockedLP, FeeRouter, ReferralRegistry, RewardsVault, QuotePricer, QuoteProbe, TrampWallManager, AnonLauncher and MarketLens.

Each rocket also has its own BondingCurve. Find it from the Launchpad (`curveOf(token)`) or on the rocket's page.

## Test tokens

| Token | Address | Note |
|---|---|---|
| USDG (test) | `0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d` | Test USDG, priced at $1 |
| STRATEGY (test) | `0xf5eb226f7f0890c36a06cbd0ff843292b7b1a88c` | Default base. Testnet only. |

## Uniswap v4 (Robinhood Chain)

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

**UniversalRouter and Permit2:** Genuine Uniswap contracts. The DISCIPLE app doesn't route trades through UniversalRouter. One-tap trades use Permit2 to sign each trade.

## Network

| | |
|---|---|
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |

## Mainnet

Not deployed. There's no date.

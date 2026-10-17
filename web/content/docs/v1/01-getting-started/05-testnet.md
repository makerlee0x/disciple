---
title: Testnet
slug: /docs/testnet
section: Getting started
---
# Testnet

DISCIPLE runs on Robinhood Chain Testnet today, with test tokens. Mainnet isn't live yet, and there's no date.

| | |
|---|---|
| Network | Robinhood Chain Testnet |
| Chain ID | 46630 |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |
| Default base | test STRATEGY |
| Dollar token | mUSDG (test USDG) |

## What testnet means

- **Test tokens have no value.** Balances, PnL and fees are real on-chain numbers, in test tokens.
- **Contracts can be redeployed.** A redeploy with launch modes is pending. When it happens, the contract addresses change and older test rockets may stay on the old contracts. [CONFIRM: FLOW — what happens to existing test rockets and balances at the redeploy.]
- **Admin controls are held by the team during testnet.** See [Admin controls](/docs/safety/admin).
- **Some screens use sample data.** See Sample data below.

## Sample data

Until the indexer is wired, these screens show sample data:

- The **Launchpad** mixes live rockets with sample ones. Each row is marked LIVE or SAMPLE.
- The **leaderboard**.
- **Profile stats**, on your profile and on public profiles (`/u/…`).
- **Achievements**.
- The **crew panel** on rocket pages.
- **Tramps and walls** place practice orders for now. See [Tramps and walls](/docs/trading/tramps-and-walls).
- **Rocket Factory** parts.
- **Share cards**, when your wallet has no indexed trades yet.

Sample data is always labelled on screen. Trading, balances, the Cash panel, launching and usernames are live.

## Before mainnet

A professional audit is required before mainnet. The contracts have had internal security reviews only, no third-party audit. See [Contracts and audits](/docs/safety).

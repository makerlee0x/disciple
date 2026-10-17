---
title: Deposits, withdrawals and gas
slug: /docs/funds
section: Getting started
---
# Deposits, withdrawals and gas

## USDG

USDG is a dollar stablecoin on Robinhood Chain. DISCIPLE treats 1 USDG as $1. It is always available as a base, and it is the deposit that activates referrals.

On testnet you use **mUSDG**, a test version with no value.

## Deposit

Open your profile, then **Cash → Deposit**. Copy your account address and send tokens to it on Robinhood Chain.

- A deposit is a plain transfer to your account address. Any ERC-20 or ETH you send arrives there.
- The Cash panel shows ETH (for gas), test STRATEGY and mUSDG. Use **Get test funds** to top up the test tokens.
- You trade each rocket with its base: test STRATEGY by default, or USDG for USDG-paired rockets.
- At mainnet launch the plan is **USDG deposits only**. [CONFIRM: FLOW + lee — the code accepts any ERC-20 or ETH and trades spend the rocket's base; nothing enforces USDG-only. Decide whether launch is USDG-only before this line ships.]

Send only on Robinhood Chain. Tokens sent on another network will not arrive.

## Withdraw

Open **Cash → Withdraw**. Pick a token, enter an amount (or **Max**) and a destination address, then press **Withdraw**. Withdrawals go out on Robinhood Chain only.

## Gas

Every action is a transaction on Robinhood Chain, and you pay its gas in ETH. On testnet, use the ETH faucet linked in the Cash panel.

Gas sponsorship is not enabled today. [CONFIRM: FLOW — whether testnet tops up gas automatically on first use.]

## Approvals

You approve each asset once. After that, every trade is a single transaction.

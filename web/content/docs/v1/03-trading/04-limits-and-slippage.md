---
title: Wallet cap and trade limits
slug: /docs/trading/limits
section: Trading
---
# Wallet cap and trade limits

## Wallet cap (bonding curve)

A rocket can carry a per-wallet holding cap while it's on the curve.

- **Default: no cap.** The team can set a protocol-wide cap for new launches (0–100% of supply).
- **Fixed per rocket.** The cap in force at launch applies for that rocket's whole curve. Changes affect new rockets only.
- **Curve only.** No cap after graduation.
- **No exemptions** when a cap is set.
- Older testnet rockets (from earlier deploys) carry a fixed 7% cap.

The app shows the cap only when a rocket has one. [Launch modes](/docs/launch/modes) (coming) add their own caps.

## Slippage

Every trade sets a minimum amount out. If the price moves against you past your slippage setting before the trade lands, it reverts and you keep your funds. Set slippage in **⚙ ADV → Swap settings**.

- **Default: Auto (1%).**
- **Custom:** any value up to 50%.
- **One-tap trading:** trades also stay within the max slippage you chose for the session. The default session max is 5%.

## Deadline

Every trade also has a deadline. A trade that lands too late reverts.

These two checks are DISCIPLE's MEV protection.

## Max price impact (after graduation)

Trades through the DISCIPLE router revert if one swap would move the pool price by more than **50%**. Split a very large trade into smaller ones. [CONFIRM: FLOW — PR #75 also applies the router's 50% cap to curve trades routed through it; confirm before release.]

## Always live

There is no pause. Curves and graduated pools are always open.

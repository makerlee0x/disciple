---
title: Wallet cap and trade limits
slug: /docs/trading/limits
section: Trading
---
# Wallet cap and trade limits

## Wallet cap (before orbit)

A rocket can carry a per-wallet holding cap while it is still on its starting price path. People also call that path a bonding curve, which means each buy costs a little more than the last.

- **Default: no cap.** The team can set a protocol-wide cap for new launches (0–100% of supply).
- **Fixed per rocket.** The cap in force at launch applies until that rocket reaches orbit. Changes affect new rockets only.
- **Before orbit only.** There is no cap after the rocket reaches orbit. Reaching orbit means the starting price path is finished and the rocket moves to the open market on Uniswap.
- **No exemptions** when a cap is set.
- Older testnet rockets (from earlier deploys) carry a fixed 7% cap.

The app shows the cap only when a rocket has one. [Launch modes](/docs/launch/modes) (coming) add their own caps.

## Slippage

Slippage is how far the price is allowed to move against you before a trade is refused. Every trade sets a minimum amount you must receive. If the price moves past that before the trade lands, the trade is refused and you keep your funds. Set it in **⚙ ADV → Swap settings**.

- **Default: Auto (1%).**
- **Custom:** any value up to 50%.
- **One-tap trading:** trades also stay within the max slippage you chose for the session. The default session max is 5%.

## Deadline

Every trade also has a deadline. A trade that lands too late reverts.

These two checks are DISCIPLE's MEV protection.

## Max price impact (after orbit)

After the rocket reaches orbit, a trade through the DISCIPLE router is refused if that one trade would move the pool price by more than **50%**. Split a very large trade into smaller ones. [CONFIRM: FLOW — PR #75 also applies the router's 50% cap to curve trades routed through it; confirm before release.]

## Always live

There is no pause. A rocket can be traded the whole way, before and after it reaches orbit.

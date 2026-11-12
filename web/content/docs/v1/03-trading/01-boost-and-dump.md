---
title: BOOST and DUMP
slug: /docs/trading
section: Trading
---
# BOOST and DUMP

On DISCIPLE, buying is **BOOST** and selling is **DUMP**.

| On screen | Means | Effect |
|---|---|---|
| **BOOST** | Buy the rocket, paying in its base | The rocket lifts |
| **DUMP** | Sell the rocket, paid in its base | The rocket drops a bomb |

## Where you trade

You always trade at the market. Where that market is depends on the rocket's phase:

- **Before orbit:** against the rocket's starting price path. People also call this a bonding curve, which means each buy costs a little more than the last. See [The starting price path](/docs/curve).
- **After orbit:** on the open market on Uniswap. See [Reaching orbit](/docs/curve/graduation).

The buttons work the same in both phases.

## Choosing an amount

**BOOST presets.** Six dollar presets sit in the BUY row. They scale with the rocket's altitude, which is how high its value has climbed, so a preset moves a small rocket and a large one by a similar amount. Type a custom amount to override them.

**DUMP presets.** 10%, 25%, 50% or 100% of your bag. You can also type a custom % or $ amount. Sell presets are editable in settings.

Selecting a preset never trades. Only BOOST and DUMP trade.

## Keyboard

| Key | Action |
|---|---|
| `Space` | BOOST the selected amount |
| `Shift` | DUMP the selected amount |
| `1`–`6` | BOOST that preset instantly |
| `Z` `X` `C` `V` | Select 10% · 25% · 50% · 100% to DUMP (selects only, never trades) |
| `A` / `D` or `←` / `→` | Steer the rocket |

With no coins in your wallet, DUMP is disabled.

## What you pay

Every BOOST and DUMP pays a 1% trade fee. On the curve, a creator tax of 0–7% may apply. In the first 7 seconds after launch, BOOSTs pay a sniper tax. See [Trade fee](/docs/fees).

## Your position

The panel under the rocket's value shows your holdings, average entry, % gain or loss, unrealized and realized profit. Profit uses your average cost, including fees and gas. A dashed **YOUR ENTRY** line marks the altitude where you bought, which is how high the rocket's value was then.

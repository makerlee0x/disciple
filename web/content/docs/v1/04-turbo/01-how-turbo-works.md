---
title: How Turbo works
slug: /docs/turbo
section: Game modes
---
# How Turbo works

Turbo is leveraged BTC, played as a race. Duel and Climb both run on it. Every tap is a real order on **Lighter**, a perps exchange, and your PnL is the real fill.

```cards
Duel | 1v1 | /art/modes/duel.webp | /docs/turbo/duel | pink
Climb | Solo | /art/modes/live.webp | /docs/turbo/climb | easy
```

## Under the hood

```flow
You tap | BOOST · DUMP · Cash out | gold
DISCIPLE | Sends the order | white
Lighter | Fills it on the BTC book | pink
Your Turbo cash | Real PnL, real balance | easy
```

- **Your account.** Turbo cash sits in your own Lighter account, tied to your wallet. It's not pooled with anyone else's.
- **Real fills.** BOOST opens a long, DUMP opens a short, Cash out closes. Entry, exit and PnL come from Lighter's fills, not a simulation.
- **Real prices.** The BTC price on screen is Lighter's.
- **Fast.** A tap reaches the exchange in about 0.4s.
- **The clock.** When the buzzer goes, anything still open is closed for you.

## Cash in and out

Turbo cash and Cash are separate balances. Relay moves money between them in seconds.

```flow
Cash | USDG · Robinhood Chain | gold
Relay | ~4¢ on $10 | white
Turbo cash | USDC · Lighter | pink
```

Details in [Cash and Turbo cash](/docs/funds).

## Fees

```stats
1.1 bp | Round trip (0.011%)
50× | Max leverage
```

That's the exchange fee plus a tiny DISCIPLE cut, both per side.

## Real money vs play money

| | Real money | Play money |
|---|---|---|
| Modes | Duels and Climb on Turbo cash | Bot duels and practice |
| Orders on Lighter | Yes | No |
| Ranked | Quick-match duels | Never |

## Liquidation

Leverage cuts both ways. Lose most of the cash in a position and it's liquidated: the **NUKE**. It's your money on the line, so size it like it.

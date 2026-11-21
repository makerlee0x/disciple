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
DISCIPLE | Sends the order in ~0.4s | white
Lighter | Fills it on the BTC book | cyan
Turbo cash | Real PnL, real balance | easy
```

- **Your account.** Turbo cash sits in your own Lighter account, tied to your wallet. It's never pooled with anyone else's.
- **Real fills.** BOOST opens a long, DUMP opens a short, Cash out closes it all. Entry, exit and PnL come from Lighter's fills.
- **Real prices.** The BTC price on screen is Lighter's.
- **The clock.** When the buzzer goes, anything still open is closed for you.

## Leverage, in one picture

What a 0.5% BTC move does to $20 at each gear:

```bars
10× | 1 | ±$1 | easy
20× | 2 | ±$2 | easy
30× | 3 | ±$3 | gold
40× | 4 | ±$4 | hard
50× | 5 | ±$5 | expert
```

Same move, five times the swing at 50×. That cuts both ways.

## The NUKE

Lose too much of a position and it's closed for you, before Lighter would liquidate it. That's the **NUKE**. How far BTC can move against you first:

```bars
10× | 8 | 8% | easy
20× | 4 | 4% | easy
30× | 2.38 | 2.4% | gold
40× | 1.38 | 1.4% | hard
50× | 0.78 | 0.78% | expert
```

## Fees

```stats
1.1 bp | Round trip (0.011%) | gold
50× | Max leverage
$0 | Gas
```

That's Lighter's fee plus a tiny DISCIPLE cut, both per side. On a $1,000 position, a round trip costs about 11¢.

## Your Turbo page

**Turbo** in the top bar opens your page: Turbo cash, PnL by day, week and all time, your Duel and Climb record and every trade. Others see it at `/u/<name>/turbo`, without your balance.

## Real money vs Simulator

The switch at the top of the Duel and Climb lobbies.

| | Real money | Simulator |
|---|---|---|
| Money | Your Turbo cash | Play money |
| Orders on Lighter | Yes | No |
| Ranked | Quick-match duels | Never |

Real money isn't offered in the US. There it's Simulator only.

Cash in and out: [Cash and Turbo cash](/docs/funds).

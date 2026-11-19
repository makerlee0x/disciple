---
title: Anti-snipe
slug: /docs/trading/anti-snipe
section: Trade rockets
---
# Anti-snipe

Bots that buy in the first second pay for it. For 7 seconds after launch, BOOSTs pay a sniper tax that drops every second.

![Sniper tax by second after launch: 99%, 25%, 3%, 1%, 0.3%, 0.1%, 0.03%, then 0% from 7 seconds.](/illustrations/docs/anti-snipe.svg)

- BOOSTs only. DUMPs never pay it.
- Bonding curve only.
- The creator's Ticket doesn't pay it.
- Counted in whole seconds: a buy at 1.5s pays 25%.

## Where it goes

Held aside, outside the price.

```flow
Sniper tax | Held by the rocket | gold
Orbit within 12 days | Into the locked LP | easy
No orbit by day 12 | Community rewards vault | white
```

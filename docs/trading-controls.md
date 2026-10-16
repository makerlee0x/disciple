# Flight trading controls & PnL rules (2026-10 gameplay audit)

## Buy / sell shortcuts
| Input | Action |
|---|---|
| Click a `$` tile in the BUY row, or `1`–`6` | **Buys** that preset now (same as the SELL row: click = trade). Hover shows "click to buy $X"; a short flash confirms the press. The tile also becomes the amount for `Space`. |
| `Space` / ▲ BOOST | Buy the selected preset (or the custom $ field when filled). |
| Click a SELL preset, or `Z` `X` `C` `V` | Sell **25% · 50% · 100% · INITIALS** of the bag (fraction of tokens; INITIALS = recover the cost basis). |
| `Shift` / ▼ DUMP | Sell the selected $ amount (capped at the bag's value). |

Sell presets are editable in ⚙ ADV → Swap settings. Saved presets from before the audit that still equal the old
defaults (12 / 33 / 77) are migrated to 25 / 50 / 100; any slot you edited is kept (settings `v: 2`).

**No tokens ⇒ no sell.** DUMP, the SELL row and Z/X/C/V are greyed out with zero holdings; pressing them shows
"no tokens to sell" and makes no trade and no bomb. Guards: the engine (`trade()`), the paper/sim ledgers
(`applyFill` never sells more than the bag; the sim refuses with "no tokens to sell") and the live path (real wallet
balance, `amountIn ≤ balance`). Live holdings come from the wallet's token balance (polled, refreshed after trades).

## Steering
Hold `A`/`D` (or ←/→) to steer. After 1.5 s without steering input the rocket eases back to the horizontal centre
over ≈2.5 s (critically damped, no overshoot); any steering input cancels it immediately. Same in every mode,
including Touch Grass and /flight/sim. Tested by `npm run test:recenter`.

## PnL rules (lib/pnl.ts, tested by `npm run test:pnl`)
- `uPnL = holdings × (mark − avgEntry)`; the mark is the SAME shown market cap the HUD and the rocket use
  (paper: confirmed × simulated-market offset; live: real pool price; sim: the local market).
- Entry mcap = token-weighted average (buy fee + gas in the cost basis).
- A sell moves exactly the closed share of uPnL into realized; % presets close that fraction of the TOKENS.
- After a full sell: holdings 0, uPnL 0, realized = the total. Exit fees + gas are booked separately (`fees`).
- Prices are `mcap / supply` with supply = 7B for every DISCIPLE source (mock included). Positions remember the
  supply they were booked with and are rebased if it differs; a mock-replay position is dropped when the mock
  restarts (it restarts at its start mcap on every load, so an old entry would be meaningless).

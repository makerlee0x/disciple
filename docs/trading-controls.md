# Flight trading controls & PnL rules (2026-10 gameplay audit)

## Buy / sell: select, then fire (shortcuts fire instantly)
| Input | Action |
|---|---|
| Click a `$` tile in the BUY row | **Selects** it (gold tile). Never trades. Hover: "click to select $X". |
| Click a SELL preset | **Selects** it (filled pink). Never trades. Default selection 25% (slot 1). |
| ▲ BOOST / `Space` | Buys the **custom $ field if one is typed**, otherwise the selected BUY preset. The button shows the amount (`▲ BOOST $5`, or `▲ BOOST $12 custom`). |
| ▼ DUMP / `Shift` | Sells the selected SELL preset (`▼ DUMP 50%`; INITIALS = recover the cost basis). Disabled with 0 tokens. |
| `1`–`6` | Shortcut: **buy** that preset instantly and select it. |
| `Z` `X` `C` `V` | Shortcut: **sell** 25% · 50% · 100% · INITIALS instantly and select it. |

Both selections are remembered (localStorage `${scope}sel`, per paper / live / simulator scope).

Sell presets are editable in ⚙ ADV → Swap settings. Saved presets from before the audit that still equal the old
defaults (12 / 33 / 77) are migrated to 25 / 50 / 100; any slot you edited is kept (settings `v: 2`).

**No tokens ⇒ no sell.** DUMP, the SELL row and Z/X/C/V are greyed out with zero holdings; pressing them shows
"NO TOKENS IN WALLET" and makes no trade and no bomb. Guards: the engine (`trade()`), the paper/sim ledgers
(`applyFill` never sells more than the bag; the sim refuses with "NO TOKENS IN WALLET") and the live path (real wallet
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

# Flight trading controls & PnL rules (2026-10 gameplay audit)

## Buy / sell: select, then fire (1–6 buy instantly; Z/X/C/V only select)
| Input | Action |
|---|---|
| Click a `$` tile in the BUY row | **Selects** it (gold tile). Never trades. Hover: "click to select $X". |
| Click a SELL preset | **Selects** it (filled pink). Never trades. Default selection 25% (`X`). |
| ▲ BOOST / `Space` | Buys the **custom $ field if one is typed**, otherwise the selected BUY preset. The button shows the amount (`▲ BOOST $5`, or `▲ BOOST $12 custom`). |
| ▼ DUMP / `Shift` | Sells the **custom sell field if one is typed**, otherwise the selected SELL preset. The button shows the exact amount (`▼ DUMP 10%`, `▼ DUMP 37% custom`, `▼ DUMP $129.12K custom`). Disabled with 0 tokens. |
| Custom sell field + `%`/`$` toggle (next to DUMP) | `%` (default) = percent of holdings (max 100). `$` = USD value, capped at the position value. Enter fires it. The unit is remembered. |
| `1`–`6` | Shortcut: **buy** that preset instantly and select it. |
| `Z` `X` `C` `V` | **Select only** 10% · 25% · 50% · 100% (updates the DUMP selection and label). They never trade: pressing `V` does not dump everything. `Shift` / DUMP sells. |

Amounts on buttons and labels use the shared formatter (`fmtMoney`, lib/pnl.ts): under $1K two decimals (`$0.20`, `$129.12`), from $1K always two decimals with K/M/B/T (`$129.12K`, `$1.50M`).

Both selections are remembered (localStorage `${scope}sel`, per paper / live / simulator scope).

Sell presets are editable in ⚙ ADV → Swap settings. Defaults are 10 / 25 / 50 / 100 %
(INITIALS was removed). Saved presets that still equal an old default (v1 12 / 33 / 77, v2 25 / 50 / 100) or a slot set
to INITIALS migrate to the new default for that slot; any custom numeric value is kept (settings `v: 3`). A remembered
SELL selection from the old layout moves with its preset (25 → `X`, 50 → `C`, 100 → `V`, INITIALS → 25%).

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

# lib/turbo — Turbo adapter (SITE)

**Practice only today.** `getTurboAdapter()` returns a mock: random-walk BTC/ETH prices, leverage up to 1000×, a
practice fuel balance in localStorage (`disciple.turbo.fuel.v1`). No real money, no wallet, no chain, no calls to nova.
Nothing here may go live with real money without lee's OK (and legal + geoblocking + AUDIT, see turbo-plan.md).

| File | What |
|---|---|
| `types.ts` | The contract GAME codes against: `Market`, `Side`, `Position`, `TurboEvent`, `Quote`, `TurboAdapter`, … |
| `index.ts` | `getTurboAdapter()` (the seam), `isTurboEnabled()`, re-exports the types |
| `mockAdapter.ts` | `createMockAdapter(opts)` practice implementation (configurable fee bps, liq threshold, funding, fill delay) |
| `math.ts` | Pure math: fees on notional, PnL, liquidation price incl. fees, funding, partial close |
| `fuel.ts` | Practice fuel store (own localStorage key; never touches game cash or `lib/wallet`) |
| `useTurboFuel.ts` | React hook: `{ usd, addFuel, withdrawFuel, busy, error, practice }` |
| `geo.ts` / `useTurboGeo.ts` | Geoblock **stub** — always `allowed: true`; TODO real server-side check |
| `flag.ts` | `isTurboEnabled()`: `NEXT_PUBLIC_TURBO=1` at build, or `?turbo=1` once (stored in localStorage `disciple.turbo.enabled.v1`; `?turbo=0` clears) |

UI: `components/turbo/TurboFuelPanel.tsx` (bare Add fuel / Take fuel out box). Tests: `npm run test:turbo`.

## Rules for any adapter
- Everything in $; prices are $ per coin; `ts` in ms.
- `open()` resolves with `{ id }` as soon as the order is sent. The position is `pending` until a `filled` (or
  `failed`) event — nova fills in two steps, seconds later. Lock the fuel at send; refund on `failed`.
- `liqPrice` **includes fees** (open fee, estimated close fee, funding so far).
- `pnlAfterFeesUsd = pnlUsd − openFeeUsd − closeFeeUsdEst + fundingUsd`.
- `close(id, 25|50|100)`: 100 emits `closed` (reason `manual`); 25/50 emit `partial-closed`. TP/SL closes carry
  reason `tp` / `sl`; liquidations emit `liquidated`.
- Player-facing error messages: plain, dollars only, no jargon. Put technical detail in `console.warn('[disciple] …')`.
- Set `kind` (`"practice"` | `"nova-sdk"` | `"nova-api"`) and `MarketInfo.practice` honestly — screens label practice data.

## Adding a real adapter (nova SDK or API — TBD which nova offers)
1. Create `novaSdkAdapter.ts` **or** `novaApiAdapter.ts` exporting `createNova…Adapter(config): TurboAdapter`.
   - **SDK path** (e.g. Gains-style SDK against nova's contracts): map `open` → `openTrade`, `close(100)` →
     `closeTradeMarket`, `close(25|50)` → `decreasePositionSize`, `setTpSl` → `updateTp`/`updateSl`; liquidation price
     from the SDK's helper; trader = the player's own wallet.
   - **API path** (REST + WebSocket): REST for markets / trading variables / open positions; one WebSocket for prices
     (fan out per market inside `subscribePrice`) and one for trade events (`registerTrade` → `filled`,
     `unregisterTrade` / liquidation → `closed` / `liquidated`, etc.). Reconnect with backoff; re-emit the latest tick
     to new subscribers.
   - Fuel: `getFuel`/`onFuel` read the real balance (wallet USDC + collateral in open trades). `addFuel`/`withdrawFuel`
     start the real deposit / withdraw flows.
2. Reuse `math.ts` only as a fallback; prefer the venue's own numbers (fees, funding, liq price) when it gives them.
3. Pick it in `index.ts` `getTurboAdapter()` behind a flag. No screen code changes.
4. Write tests against recorded fixtures (no live calls in CI). Get lee's OK + AUDIT before any real-money switch.

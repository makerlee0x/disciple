# DISCIPLE Turbo (`/turbo`, hidden)

Live front end for Turbo: BTC and ETH, BOOST (long) / DUMP (short), leverage presets 100× / 250× / 500× / 1000× plus a
custom field, four dollar fuel chips plus a custom field, market orders only, one-tap close at 25 / 50 / 100 percent,
liquidation price always on screen, H-BOMB on liquidation, share cards in dollars. Hidden `/turbo` lives in the existing DISCIPLE game chrome (collapsed rail, full-bleed sky, ticket, trade bar) — not a Nova terminal. The rocket follows live BTC/ETH market cap even with no position open (Hyperliquid public mid + trades streams as the stand-in). No take-profit, stop-loss or limit orders. No geoblock. Not in the public nav.

## Turn it on (this device only)
Visit `/turbo?turbo=1` once (sets localStorage `disciple.turbo.enabled.v1`). `/turbo?turbo=0` turns it off. Without the
flag the page renders nothing (server render and first paint are empty). `NEXT_PUBLIC_TURBO=1` at build time also turns
it on; it is not set anywhere and must not be set on Vercel.

## Files
| Path | What |
|---|---|
| `lib/turbo/types.ts` | the adapter contract (`TurboAdapter`, `Position`, `TurboEvent`, `Quote`, `MarketInfo`, `DepositInfo`) |
| `lib/turbo/index.ts` | `getTurboAdapter()` — THE seam (kinds `practice` = stand-in, `nova-api`, `nova-sdk`) |
| `lib/turbo/mockAdapter.ts` | the stand-in: prices + fills only (fees on notional, liquidation incl. fees, funding, partial close, pending → filled) |
| `lib/turbo/priceFeed.ts` | Hyperliquid public WebSocket: `allMids` (live mids) + `trades` (completed buys/sells). HTTP info poll only if the socket is down. Read-only, no key. |
| `lib/turbo/math.ts` | pure position math |
| `lib/turbo/fuel.ts` | stand-in Turbo fuel store (`disciple.turbo.fuel.v1`), separate from DISCIPLE cash |
| `lib/turbo/flight.ts` | mid × circulating supply → market cap (flight height), danger 0..1, jetstream `L`, big-win rule. Height is never PnL. |
| `lib/turbo/prefs.ts` | fuel / leverage presets and the player's picks |
| `lib/turbo/copy.ts` | every player-facing string (for lee / Brand) |
| `lib/turbo/useTurbo.ts` | screen hook: prices, fuel, positions, events |
| `components/turbo/*` | screen, flight mount, funding sheet, share card, H-BOMB overlay, How Turbo works |
| `public/flight/engine.js` | current-main flight engine; `?source=turbo` mode (`@turbo` block) |
| `scripts/test-turbo.mts` | `npm run test:turbo` |

## Plugging in Nova (when their API or SDK arrives)
1. Add `lib/turbo/novaApiAdapter.ts` (or `novaSdkAdapter.ts`) implementing `TurboAdapter` with `kind: "nova-api"` /
   `"nova-sdk"`. Keep the shapes; every amount is dollars, leverage a plain multiplier.
2. Return it from `getTurboAdapter()` in `lib/turbo/index.ts`. Do not change the screens.
3. Map: `subscribePrice` → Nova's price stream; `getFuel` / `onFuel` → the player's Nova balance; `open` → market order
   (resolve with an id at once, emit `pending`, then `filled` / `failed`); `close(id, 25|50|100)` → market close / reduce;
   `onEvent` → fills, partial closes, closes and liquidations (`returnedUsd` = dollars back); `quote` → Nova's entry,
   liquidation price and fees; `getMarkets` → real max leverage per market (`leverageNote` = plain reason if lower);
   `depositInfo` → `{ token: "USDC", network: "Arbitrum", address }` with the player's real deposit address.
4. Sign-up / login and any signing path are NOT part of this pass: lee decides after talking to Nova.

## Flight (engine.js `?source=turbo&clean=1`, `components/turbo/TurboFlight.tsx`)
- Altitude is the actual BTC or ETH market cap at all times (lee, Nov 12 2026 10:40 AM CT), including with no position
  open. It follows the existing engine mark/swap path. Height is never profit after fees. A short does not flip the sky.
- Live mids come from Hyperliquid's public `allMids` WebSocket (HTTP poll only as a fallback if the socket is down).
- Live buys become boosts and live sells become bombs through the existing engine path, sized with the existing impact /
  ammo rules. Stand-in feed: Hyperliquid public `trades` (not `l2Book`). `subscribeTrades` on the adapter is the hook a
  Nova order/trade stream can later replace.
- Red liquidation seam (`__turboFx.liqMcap` = market cap at the liquidation price) below a long, a ceiling above a short;
  pinned to the screen edge if far away. Entry line uses `window.__entryMcap` the same way.
- Profit after fees is a dollar figure on the ticket and HUD only.
- Jetstream `L = log10(lev)/3` and danger 50/80/95 still apply while a position is open. Liquidation: engine ATOM bomb
  under the H-BOMB overlay, then the share card. Keep the existing background; do not add new skies.
- The engine never trades in Turbo mode; BOOST / DUMP / CLOSE call the adapter first and never wait on a frame.

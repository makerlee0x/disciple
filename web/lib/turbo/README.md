# DISCIPLE Turbo (`/turbo`, hidden)

Live front end for Turbo: BTC and ETH, BOOST (long) / DUMP (short), leverage presets 100× / 250× / 500× / 1000× plus a
custom field, four dollar fuel chips plus a custom field, market orders only, one-tap close at 25 / 50 / 100 percent,
liquidation price always on screen, SUPERNOVA (placeholder) on liquidation, share cards in dollars. No take-profit,
stop-loss or limit orders. No geoblock. Not in the public nav.

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
| `lib/turbo/priceFeed.ts` | live BTC / ETH mid prices from Hyperliquid's public `allMids` (read-only, no key) for the stand-in |
| `lib/turbo/math.ts` | pure position math |
| `lib/turbo/fuel.ts` | stand-in Turbo fuel store (`disciple.turbo.fuel.v1`), separate from DISCIPLE cash |
| `lib/turbo/flight.ts` | PnL-after-fees → altitude, liquidation line altitude, danger 0..1, jetstream `L`, big-win rule |
| `lib/turbo/prefs.ts` | fuel / leverage presets and the player's picks |
| `lib/turbo/copy.ts` | every player-facing string (for lee / Brand) |
| `lib/turbo/useTurbo.ts` | screen hook: prices, fuel, positions, events |
| `components/turbo/*` | screen, flight mount, funding sheet, share card, SUPERNOVA overlay, How Turbo works |
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
- Altitude = PnL after fees (`pnlToAlt`): a long climbs as profit grows; a short is a nose-down dive run and goes down.
- Red liquidation seam (`__turboFx.liqMcap`) below a long, a ceiling above a short; pinned to the screen edge if far away.
- Jetstream `L = log10(lev)/3` drives flame, baseline airspeed; 1000× adds a heat shimmer and slight field-of-view pull.
- Danger (share of the way from entry to liquidation): 50% orange glow + "Running hot", 80% shudder (existing wobble
  spring) + red pulse, 95% sputter + red vignette + "About to blow!".
- Liquidation: engine ATOM bomb under the SUPERNOVA overlay (~6 s; ~1.2 s when bombs are off), then the share card.
- The engine never trades in Turbo mode; BOOST / DUMP / CLOSE call the adapter first and never wait on a frame.

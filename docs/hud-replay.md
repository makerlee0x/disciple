# HUD+ and the replay hook (feat/hud-replay)

## Tier progress bar (inside the top-left MCAP panel)
The panel shows the current tier and a gold bar filled by log-progress inside the tier band. Below the bar it shows
`→ NEXT TIER $threshold` and `≈$X buys needed`.

How "buys needed" is computed (`usdToReach` in engine.js, a float copy of CurveMath.sol / lib/sim/market.ts):
- **Before graduation (< $33,333):** the curve's virtual quote reserve is x(M) = x0·√(M/M0), with
  x0 = M0·0.72·√r/(√r−1) and r = 33K/7K. Needed = (x(target) − x(now)) / (1 − 1% fee). This is exact for the curve.
  It ignores the 7-second anti-snipe tax.
- **After graduation:** constant product, seeded with X_grad = $33,333·28%, so X(M) = X_grad·√(M/33,333).
  Needed = ΔX / (1 − fee). This is an approximation that assumes no other flow.
- **Crossing $33,333:** the curve part up to $33,333 plus the pool part beyond it.
- **/flight/sim:** the sim's own depth is used (inverted from `source.impact`) whenever the current price and the
  target are in the same phase.

## Chart-map (M toggles it, saved in localStorage `disciple.chartmap`)
Mini red/green mcap candles with a price axis on the right. Tier thresholds are labelled dashed lines. Your own
buys and sells are ▲ and ▼ on their candle.
- **Frame:** Guild Wars-style dark beveled window with a title bar ($TICKER · TIER).
- **Grid:** Warzone-style, with A–H and 1–5 on the edges.
- **Current point:** a full-span crosshair through the latest candle and price, with a glowing ringed marker.
- **Rendering:** cached offscreen canvas, redrawn at 6 Hz of sim time, blitted at 86% alpha.
- **Restyling:** edit `CHART_STYLE` in engine.js.
- **Placement:** live mode puts it between the PnL panel and the trades feed. /flight/sim puts it in the right
  column. Clean replay mode puts it bottom-left.

## Replay
```js
const r = await window.__flight.replay({coin, supply, ticker, t0, t1,
  trades:[{ts,tx,li,side,usd,mcapUsd,impactBps,trader,mine}], startMcap,
  durationSec:12, fps:30, width:1080, height:1920, seed, clean:true, canvas?});
r.canvas; r.frames; r.fps; r.trades          // re-timed trades (`at` = seconds on the video timeline)
r.step()      // renders the next frame synchronously → {i,t,done} | null after the last frame
r.stateAt(t)  // {t, mcap, tier, tierName, tradesSoFar, frame} (pure, from the trade list)
r.on('trade'|'bomb'|'tier'|'frame', cb) → unsubscribe
r.hash()      // FNV-1a of the current frame's pixels (determinism checks)
r.dispose()
```
- **Isolation:** a second engine instance is evaluated from engine.js in a sandbox (a with-scope over a fake window,
  `?source=hook&capture=1&fixedDt=fps&dpr=1`). The live `window.__flight`, its canvas, events and localStorage are
  untouched. The worker render mode proxies `replay` on the main thread.
- **Determinism:** performance.now, Date, setTimeout/setInterval and rAF all run on the replay clock. Math.random is
  seeded (mulberry32). There is no rAF and no timer, so it works in a hidden tab.
- **Timing:** trades in [t0, t1] are mapped onto [0.6 s, durationSec − 1.2 s] in order. This leaves a lead-in and an
  ending hold.
- **`mine` trades:** they get a large "YOU BOUGHT / YOU SOLD $X" callout and a chart marker.
- **Clean mode:** hides the status, KOTH, feed, controls, ammo, achievement toasts and trader floaters.
- **Demo:** /dev/replay renders the replay and records WebM with MediaRecorder.
- **Test:** `BASE_URL=… npm run test:replay`.

## Rocket loadout (cosmetic)
`replay({..., loadout:{skin, thruster, noseCoin}})`. The live engine has the same thing: `window.__flight.setLoadout(l)` and
`getLoadout()`. FlightCanvas applies the equipped Rocket Factory parts from `disciple.rocket.loadout.v1`.
- **Ids:** these are SITE's rocket upgrades (`web/lib/rocketSkin.ts`, without the `body-` / `thr-` / `coin-` prefixes).
  - skin: chrome (default), gold, rose, green, cobalt, violet, matte, crimson
  - thruster: stock (default), seraph, ion, plasma, venom, inferno
  - noseCoin: halo (default), sun, star, moon, diamond, frog, plus `'ticker'` (a badge with the ticker) and `'none'`
- **Unknown values** fall back to the default. `r.loadout` returns the normalized ids.
- **Skin:** uses the same tint recipe as SITE's tintBase.
- **Thruster:** changes the flame colours (core/flame) and the length/width of the flame.
- **Nose coin:** the emblem sits on the decal roundel. In the live game, the token decal keeps the roundel.
- **Determinism:** test:replay also runs a loadout case, so loadouts stay deterministic.

## Tier list (single source of truth)
`web/lib/flight/tiers.ts` exports `FLIGHT_TIERS` ({name, lo, hi, bg, sky}), `tierIndexAt` and `tierAt`.
- **Embedding:** `engine.js` and `replay.js` include a block generated from tiers.ts + rocketSkin.ts. Run `npm run gen:flight`
  to regenerate it; `npm run test:flightdata` fails if the block has drifted.
- **Runtime access:** `window.__flight.tiers` (main and worker), `window.__flightReplay.tiers` / `.cosmetics`, and `r.tiers`.

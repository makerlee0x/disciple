# How fast can a browser game run? (DISCIPLE flight)

**Ceiling:** requestAnimationFrame fires once per display refresh: 60, 120, 144 or 240 Hz. You can't present frames faster than the display. Frame budgets are 16.7 / 8.3 / 6.9 / 4.2 ms. "Seamless" means hitting the display rate every frame with no long frames. A high average doesn't count.

**Where DISCIPLE stands (1280×800 headless):** about 60 fps idle and 50 fps during explosion bursts. That's after the earlier perf work (originally 13/8 fps) and this branch's cheap wins. Burst frames are fill-rate bound: large additive sprites, the full-screen vignette and grain, and the bomb FX.

| Option | What it buys | Est. gain for this game | Effort |
|---|---|---|---|
| `alpha:false` + `desynchronized:true` 2D context (**done**) | The compositor skips blending the canvas; lower latency | +2–8 fps in bursts (measured 42→50) | trivial |
| Adaptive resolution governor (**done**) | Steps DPR 2→1.5→1.25→1 under sustained load, back up when there's headroom | Up to ~2× fill rate on HiDPI laptops; holds 60/120 Hz | small |
| Avoid layout in the loop | No reads of `getBoundingClientRect`/`offsetWidth` per frame; React HUD is event-driven, and the wallet measure runs at 2.5 Hz | Removes the occasional 2–6 ms forced-layout spikes | done / small |
| Sprite atlas (one image for clouds, particles, flame) | Fewer texture binds; matters mostly for WebGL | ~5% on Canvas2D; large on WebGL | small |
| **OffscreenCanvas + Web Worker** | Rendering and the sim leave the main thread, so React renders, wallet popups and GC no longer cause dropped frames | Fixes the "hitches" more than raw fps. p95 frame time ~33→17 ms during UI activity | **medium, ~2–3 days**: engine.js reads `window`/DOM (orb button, `__flight`, events, `getBoundingClientRect` for clicks), so input and events must go over `postMessage`. Images move via `createImageBitmap`. Supported in Chrome, Edge, Firefox and Safari 17+. Fallback: today's main-thread path |
| **WebGL2 instanced renderer** (PixiJS v8 or custom) | Particles, clouds, trail and sprites go out in a few instanced draw calls; additive blending is nearly free on GPU | Burst 50 → steady 120–144 fps at native DPR; thousands of particles affordable | **large, 1–2 weeks** (rewrite draw*; keep the sim) |
| WebGPU | Same as WebGL2 plus compute for particles | Marginal over WebGL2 here; Safari/Firefox support still partial | large; not yet |

**Recommendation, in order:**
1. Keep the cheap wins in this PR: context flags, the DPR governor, and no per-frame layout.
2. Move the loop into a worker with OffscreenCanvas next. It gives the biggest perceived-smoothness gain per day of work, because the visible hitches come from main-thread contention (React, wallet, GC) more than raw draw cost.
3. Do a WebGL2 instanced renderer (PixiJS v8 is the fastest path) only if we want 120/144 Hz at full DPR, or 10× the particles.

A rough 120 Hz budget for this scene on WebGL2 is under 3 ms of GPU time, so a 240 Hz display is realistic for the sim+render path. Canvas2D tops out near 60–90 fps at 2× DPR on a mid laptop during bursts.

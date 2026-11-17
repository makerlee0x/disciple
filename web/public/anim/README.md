# Grok animation clips

From the Grok animation handoff (maker, 2026-11-17). Ids match the handoff doc. Grok's originals are in maker's Drive
("DISCIPLE anim" > P1). These are compressed copies: H.264 MP4, no audio, faststart. Loops (A1, A2, C1) have a 0.5 s
crossfade baked into the seam so they repeat without a jump, and a `-poster.webp` still for loading and reduced motion.
Overlays (B2, C6, D1) are on pure black and play with `mix-blend-mode: screen`.

Played through `components/ui/AnimClip.tsx` (picks `-9x16` on portrait screens, `-16x9` on wide ones).

| Id | Where |
|---|---|
| A1-loading | `app/loading.tsx` (slow route loads, first open in the iPhone app) |
| A2-lobby | Launch page hold while the launch confirms (`components/create/LaunchLive.tsx`), signed-out lobby "Launch your own" |
| B1-liftoff | Launch page liftoff, ends on the cream white-out into the flight |
| B2-orbit | Main flight, the moment a coin reaches orbit (`components/flight/OrbitFlash.tsx`) |
| C1-finding | Trading Duel, while searching for a rival (`public/turbo/duel/engine.js`) |
| C3-duel-win / C3-duel-lose | Trading Duel result, before the card |
| C6-nuke | Trading Duel and Turbo NUKE (liquidation) |
| D1-crate-<rarity> | Hangar crate opening, all six rarities |

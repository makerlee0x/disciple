# Grok animation clips

From the Grok animation handoff (maker, 2026-11-17). Ids match the handoff doc. Grok's originals are in maker's Drive
("DISCIPLE anim" > P1, P2, P3). These are compressed copies: H.264 MP4, no audio, faststart. Loops (A1, A2, A3, A4, A5, B6, C1, C5) have a 0.5 s
crossfade baked into the seam so they repeat without a jump, and a `-poster.webp` still for loading and reduced motion.
Overlays (B2, B3, B4, C6, D1, D2) are on pure black and play with `mix-blend-mode: screen`.

Played through `components/ui/AnimClip.tsx` (picks `-9x16` on portrait screens, `-16x9` on wide ones). A fixed or
z-indexed overlay layer is its own stacking context, so the screen blend goes on that layer, not the video.

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
| A3-mode-<launch\|live\|duel\|free> | Lobby "Pick a mode" cards (`components/home/ModeSelect.tsx`), iPhone app home duel card. Royale has none yet |
| A4-featured-3x1 / -4x5 | /market banner behind the featured item (`components/hangar/MarketShop.tsx`), cut picked by the banner's shape |
| B3-bomb-<tier> | Main flight dump bombs GRENADE … NUKE, at the blast point (`components/flight/BombFlash.tsx`) |
| B4-levelup | Any screen, when a level lands while the app is open (`components/xp/LevelUpFlash.tsx`) |
| C5-podium | Turbo Royale podium background (`tools/royale/royale.tpl.html`, built into `public/turbo/royale/play.html`) |
| A5-lost / A5-engine-trouble | 404 and page error (`components/LostSky.tsx`), over the same art plates |
| A5-podium-empty | Empty Top pilots and Duels boards (`components/leaderboard/LeaderboardView.tsx`) |
| B6-daily | Daily flight result background (`components/sim/DailyResult.tsx`); the wide cut on the app home "daily flight" card |
| C4-royale-drop | Turbo Royale, over the 3-2-1 before GO (royale template + `play.html`) |
| D2-tradeup-burn | Hangar trade-up, while the trade-up runs (tap to skip) |

A5 lost and engine trouble only exist as 16:9 for now; phones get the same centre crop as the old still.

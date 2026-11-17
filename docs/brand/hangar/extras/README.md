# Hangar extras (Part B)

This is the rest of the Hangar art from Lee's brief. None of it is wired up yet. No code, catalog or manifest was changed.

## Where the files are

- **Crate bursts**: `web/public/turbo/crates/<tier>-burst.webp`, one for each of common, uncommon, rare, epic, legendary and mythic. Each is a strip of 8 frames, 512 x 512 each (4096 x 512), on black. Draw them additively.
- **Name tags**: `web/public/turbo/tags/tag-<tier>.webp` and `tag-prestige-1.webp` to `tag-prestige-9.webp`. They are 600 x 140, transparent, lossless, and the middle is left empty for the name.
- **Series banners**: `web/public/turbo/series/series-1-first-light.webp` and `series-2.webp`, 2400 x 800. The left third is kept dark for text.
- **Win flourish**: `web/public/turbo/flourish/win-flourish.webp`, 8 frames of 512 x 512 on black.
- **Marble & Gold Leaf glint**: `web/public/turbo/glint/<hull>--marble-gilt.webp`. Each file has 4 frames side by side, and each frame is the same size as that hull's 320-tall skin.
- **New paints**: `web/public/turbo/skins/<hull>--<paint>.webp`, 320 tall, using the same naming as the skins in PR #421. The paints are racing-green (common), carbon-gold (uncommon), koi and damascus (rare), stained-glass (epic), and aurora and holo-foil (legendary). They come on all 8 hulls plus the original rocket, which is saved as `rocket--<paint>.webp`.
- **Skin fixes**: `web/public/turbo/skins/<hull>--{hazard,neon-circuit,molten}.webp` now have rim lighting, and all 18 `needle--<paint>.webp` files use the wider needle. The 10 rival needles in `web/public/turbo/hulls/hull-needle--<skin>.webp` were overwritten in place with the wider needle, at the same 280 px height.
- **Sheets and previews**: in this folder, as webp.

## Needle width

The needle hull is now 410 px wide on a 1024 px canvas, up from 376. The nozzle is at x 197, y 1013. The engine still uses its old needle numbers in `engine.js` `HULLS` (aspect 0.368, nozzle 0.481, 0.989). The new art works out to aspect 0.400 and nozzle 0.480, 0.989. Until someone updates that line, the game will squeeze the wider needle into the old shape.

## Things to know

- The `skins/` folder isn't on main yet; PR #421 adds it. The skin-fix files here use the same paths as #421, so whichever of the two PRs merges second should keep the versions from this PR.
- The seven new paints aren't in `PAINTS` or any series list yet.
- The series 2 banner shows aurora and koi, and those paints aren't in #421's series 2 list.
- Prestige tags 8 and 9 had a solid white oval inside the halo. It has been cleared so they now show an open ring like the others.
- The source files that weren't shipped are a chrome needle (main has no chrome rival file to replace), the worker's `hulls.json`, scripts, and raw generations.

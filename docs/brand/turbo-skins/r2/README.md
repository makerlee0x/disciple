# Turbo art, round 2

Explosions, skin fixes, map emblems, the HYPE and SOL skies, opened chests, the storm wall, mothership, trophy and small icons. The files in this folder are review previews only, so players never download them. The game sprites live under `web/public/turbo/`.

These are files only. Nothing is wired up. This draft stacks on [PR #399](https://github.com/makerlee0x/disciple/pull/399).

Mythic is champagne `#F3DFA8`. Gold `#F2C14E` still means "you". Pink still means rivals.

## Folder map

| Folder | What is there |
|---|---|
| `web/public/turbo/fx/` | Explosion sprite sheets |
| `web/public/turbo/duel/skins/player/` | Re-run Hazard, Neon Circuit, Molten, Seraph Wing and Marble & Gold Leaf on the original hull |
| `web/public/turbo/duel/hulls/<hull>/player/` | The same five player-skin fixes on every hull |
| `web/public/turbo/duel/hulls/needle/` | Widened needle chrome, rival skins and all 18 player skins |
| `web/public/turbo/duel/hulls/hulls.json` | Needle canvas updated to 376×1024; file paths are unchanged |
| `web/public/turbo/royale/maps/` | Map emblems for HYPE, SOL, ETH and BTC |
| `web/public/turbo/sky-hype.png`, `sky-sol.png` | Sit beside the existing `sky-eth.webp` and `sky-btc.webp` |
| `web/public/turbo/royale/chests/` | Opened chests for every tier, and a champagne Mythic closed crate |
| `web/public/turbo/royale/` | `storm-wall.png`, `mothership.png` and `trophy-last-pilot.png` |
| `web/public/turbo/icons/` | Ammo, map and lock-on icons |

## Explosions

Every sheet is one horizontal row of square 512×512 frames on a transparent background. The effect is centred on the same point in every frame so the blast does not jump. That centre is 256,256, except on `fx-pod-open.png`, where the pod body sits at 256,292 and the beam rises from the window.

`fx-nuke.png` has 10 frames. `fx-weapon-break.png`, `fx-pod-open.png`, `fx-boom-small.png` and `fx-cashout.png` have 6 frames each. The five bomb-tier sheets (`fx-grenade.png`, `fx-bunker-buster.png`, `fx-warhead.png`, `fx-moab.png`, `fx-atom-bomb.png`) have 8 frames each. They are the NUKE sequence scaled to 0.40, 0.52, 0.64, 0.76 and 0.88 of its size, a little brighter at each step, with the NUKE as the biggest. The size difference is already in the art, so they can all be drawn at one sprite size.

The preview GIFs in this folder run at 12 frames a second, with two blank frames added at the end of the GIF only.

## Skin fixes

Hazard, Neon Circuit and Molten now have a thin bright rim light along the right and top edges, so the silhouette can read on navy `#121327`. Seraph Wing was re-run with stronger pale blue and pearl iridescence and visible feather-like panel lines, so it does not look like White Gloss when small. Marble & Gold Leaf leans champagne and pearl, with gold leaf kept as a metal accent rather than a mostly-gold body.

The needle hull is about 27% wider than the version in PR #399 (mid-body 130 px versus 102 px; canvas 376×1024, up from 300×1024), with the same nose and fins. Its chrome starter, ten rival skins and eighteen player skins were all re-run to that outline. Walnut & Brass on the original hull and on the other seven hulls was not re-run in this round.

## Skies

`sky-hype.png` and `sky-sol.png` are 1290×2796 vertical backgrounds: deep space above a planet horizon in the bottom third, kept dark and calm in the centre so rockets stand out. The existing `sky-eth.webp` and `sky-btc.webp` are 1280×720 landscape. Lee's brief asked for 1290×2796 vertical, so these two follow the brief. HYPE is hot and stormy, with a mint and teal aurora over a dark planet edge. SOL is violet fading into teal dusk.

## Previews in this folder

| File | What it is |
|---|---|
| `fx-nuke-preview.gif` and `fx-nuke-contact.webp` | NUKE, 10 frames |
| `fx-weapon-break-preview.gif` and `fx-weapon-break-contact.webp` | Gun break, 6 frames |
| `fx-pod-open-preview.gif` and `fx-pod-open-contact.webp` | Pod open, 6 frames |
| `fx-boom-small-preview.gif` and `fx-boom-small-contact.webp` | Small blast, 6 frames |
| `fx-cashout-preview.gif` and `fx-cashout-contact.webp` | Cash-out burst, 6 frames |
| `fx-grenade-preview.gif`, `fx-bunker-buster-preview.gif`, `fx-warhead-preview.gif`, `fx-moab-preview.gif`, `fx-atom-bomb-preview.gif` | Bomb tiers, and their matching contact sheets |
| `skins-fix-before-after.webp` | Dark skins, Seraph Wing and Marble & Gold Leaf, before and after |
| `skins-fix-hulls.webp` | Those fixes on every hull |
| `skins-fix-needle.webp` | The widened needle in chrome, rival skins and player skins |
| `emblems.webp` | The four map emblems |
| `skies.webp` | HYPE and SOL skies |
| `chests.webp` | Opened crates and the champagne Mythic |
| `props.webp` | Storm wall, mothership and trophy |
| `icons.webp` | The three small icons |

## Weak spots for lee

- The NUKE's early white flash hides the fireball for a couple of frames, and the mushroom is a violet grey rather than truly dark, because black smoke disappeared on navy.
- The bomb tiers are the NUKE scaled down.
- The rim light on the dark skins is modest, and Neon Circuit is still dim, especially on the hauler.
- The needle is about 27% wider, not 40%.
- The SOL sky clouds are soft rather than streaking, and both skies have a moon in the upper third.
- The opened Epic crate has a weaker glow than the other opened crates.
- `icon-map.png` reads more like a holo-tablet than a folded holo-map.

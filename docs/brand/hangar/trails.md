# Hangar trails

There are 17 engine trails for the Hangar collection. Each one has a looping plume and a small set of particles. This is art only, and nothing is wired up yet.

![All 17 trails](trails-contact.webp)

## Files

The game files are in `web/public/turbo/trails/`, next to the skins and crates from #421.

- `trail-<id>-plume.png` is 1536×768: 6 frames of 256×768 in one row. The plume points straight down and its nozzle sits at the top centre of every frame (x 128, y 0). Play it at 12 fps. Frame 6 flows back into frame 1.
- `trail-<id>-bits.png` is 384×128: 3 particles of 128×128, each centred in its cell. Spawn them off the plume.
- Both are on pure black (#000000), so draw them with additive blending (`globalCompositeOperation = "lighter"` on canvas). Black adds nothing.
- The animated previews are `trail-<id>-plume.webp` in this folder, at half size on navy.

This is the same flipbook sprite sheet format that Unity and Unreal use for particle textures, and it matches the layout of the fx sheets in #402.

## Rules every trail follows

- The top 10% is the same white-hot core (#FFF6DC) into gold (#F2C14E), so your rocket always reads as gold, whatever trail you fly.
- Below the core, each trail turns into its own colour and style, then fades to nothing before the bottom edge.
- There's no pink, which stays for rivals. No text or logos.

## The 17

| id | Name | Look | Rarity |
|---|---|---|---|
| gold | Gold | Champagne-gold exhaust | Common (#421) |
| mint | Mint Wake | Mint ribbon smoke | Uncommon (#421) |
| ice | Ice Wake | Pale blue crystal shimmer | Rare (#421) |
| violet | Violet Arc | Violet plasma with arcs | Epic (#421) |
| solar | Solar Flare | Orange flare filaments | Legendary (#421) |
| smoke | Smoke | Silver-white billowing smoke | |
| ember | Ember | Red-orange sparks and ash | |
| comet | Comet | Cyan ion tail | |
| glitch | Glitch | Cyan and lime pixel slices | |
| stardust | Stardust | Lavender twinkling stars | |
| toxic | Toxic | Acid-green vapour and drips | |
| frost | Frost | White-aqua mist and ice shards | |
| lightning | Lightning | Blue forked bolts | |
| lava | Lava | Molten streams and globs | |
| prism | Prism | Amber-to-violet light split | |
| feather | Feather | Pearl and pale blue feathers | |
| halo | Halo | Champagne beam with rings | |

The first five rarities come from `TRAILS` in #421. The other twelve are left blank for lee to set.

## How they were made

Each trail started from one generated master plume and one sheet of particles. The 6 frames were then built in code, so the nozzle never moves and the loop is exact. The turbulence is a tiling noise warp that scrolls one full period per loop, with a slight flicker, and the trail's own particles shed off the sides.

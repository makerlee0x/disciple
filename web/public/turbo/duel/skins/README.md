# Rival rocket skins and trails

Skins for rival rockets in the Trading Duel and Turbo Royale. Your rocket stays gold; every rival skin carries pink so rivals read as the pink side.

## Skins

Each file is a 372×1024 transparent PNG with the same silhouette as `../rocket.webp`: nose up, lit from the upper left, no flame, shadow or text. Downscale in code.

- `skin-chrome-pink-stripe.png`: polished chrome with hot pink racing stripes
- `skin-matte-black.png`: matte black stealth with light pink edge lines
- `skin-pearl-mint.png`: pearl white ceramic, light pink nose, mint fin edges
- `skin-titanium-ice.png`: brushed titanium, ice blue seams, pink fin tips (weakest at small size)
- `skin-candy-pink.png`: candy apple pink metallic with chrome fins
- `skin-gunmetal-pink.png`: gunmetal with pink pinstripes
- `skin-oilslick.png`: iridescent oil-slick, pink to blue
- `skin-carbon.png`: carbon fibre body, chrome nose, pink band
- `skin-scorched.png`: scorched re-entry chrome with chipped pink fins
- `skin-navy-chevron.png`: navy enamel with pink chevrons on the fins

## Trails

The game draws its own exhaust, so trails are color pairs and a style. `trails-preview.png` is a rough mockup for color and style only.

| Name | Core → outer | Style |
|---|---|---|
| Pink rival (current) | `#FFFFFF` → `#FF8FBD` | Soft, round smoke puffs |
| Hot pink | `#FFFFFF` → `#F0307F` | Fast and tight, short puffs |
| Ghost | `#FFFFFF` → `#D9C8FF` (pale lilac) | Long, faint, see-through |
| Glitch | `#FFFFFF` → `#FF8FBD` / `#8FB8FF` split | Blocky pixel steps, the two colors alternate |
| Smoke | `#FFFFFF` → `#8A8D9E` (grey) | Thick dark smoke, no color |
| Plasma | `#FFFFFF` → `#8FB8FF` | Thin and fast, electric flicker. Least pink, so the pink name tag carries the rival read. |

Comet (champagne) and Ember (orange) were dropped because they sit too close to the player's gold `#F2C14E`. The lilac and grey are suggested values, not brand tokens.

## Default starter

Silver chrome is the starter skin. It is the current player rocket at `../rocket.webp`, and everyone has it unlocked. These ten files are rival skins only.

## Related folders (also assets only; nothing is wired up)

- `player/` — 18 player unlock skins for this same original hull, earned with XP. XP costs are left blank for lee.
- `../hulls/` — eight more hull shapes. Each hull's chrome file is that hull's starter. Rival skins and the same 18 player skins are included for every hull.
- `../../../royale/chests/` and `../../../royale/weapons/` — supply-drop crates and Turbo Royale weapons.
- `../../../../../docs/brand/turbo-skins/` — contact sheets and mockups, kept out of the public game folder.

Nothing in this folder, or the folders above, is wired into the game yet.

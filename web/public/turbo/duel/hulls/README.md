# Rocket hull shapes

Eight unlockable hulls for Trading Duel and Turbo Royale, plus the chrome starter and skins for each one. The original hull stays the starter shape; it lives at `../rocket.webp` (silver chrome) with rival skins in `../skins/` and player unlock skins in `../skins/player/`.

These are files only. Nothing is wired up. Hull rarity and XP costs are left blank for lee.

## Default starter

Silver chrome is the starter skin. For these eight hulls, the chrome file in each folder is that hull's starter. Players unlock hulls as well as skins and trails. Any unlocked skin can go on any unlocked hull.

## Folders and names

Each hull has its own folder. Files are named `hull-<hull>-<skin>.png` for chrome and the ten rival skins, and `hull-<hull>-player-<tier>-<name>.png` in the `player/` subfolder for the eighteen player unlock skins.

| Hull | Size (px) | Chrome starter | Nozzles |
|---|---|---|---|
| `bullet/` | 464×1024 | `hull-bullet-chrome.png` | Centre, plus two smaller side nozzles |
| `needle/` | 300×1024 | `hull-needle-chrome.png` | One centre nozzle. Very thin; every skin is hard to read at in-game size. |
| `pulp/` | 572×1024 | `hull-pulp-chrome.png` | One centre nozzle |
| `twin-booster/` | 446×1024 | `hull-twin-booster-chrome.png` | Two main boosters and a smaller centre nozzle |
| `shuttle/` | 590×1024 | `hull-shuttle-chrome.png` | Centre, plus two smaller nozzles just above it |
| `hauler/` | 444×1024 | `hull-hauler-chrome.png` | Centre, plus two slightly smaller side nozzles |
| `ring-tail/` | 444×1024 | `hull-ring-tail-chrome.png` | One centre nozzle |
| `wedge/` | 748×1024 | `hull-wedge-chrome.png` | One centre nozzle, set a little higher |

Every sprite is a transparent PNG, 1024 px tall, bottom-aligned with an 8 px pad, nose up, no flame, shadow or text. `hulls.json` lists the pixel size of each hull, the file for each rival skin (paths are relative to this folder), the `player/` subfolder, and nozzle positions (x, y from the top-left, plus a scale) so exhaust can be drawn in the right place.

## Rival skins (10 per hull, plus chrome)

Every rival skin carries pink. Names match the original-hull set in `../skins/`:

chrome-pink-stripe, matte-black, pearl-mint, titanium-ice, candy-pink, gunmetal-pink, oilslick, carbon, scorched, navy-chevron.

## Player unlock skins (18 per hull)

The same 18 XP unlock skins as `../skins/player/`, fitted to each hull's chrome outline. Rarity colours and blank XP costs are documented there. Across eight hulls that is 144 files.

## Rarity colours

Common grey `#A7AFBE`, Uncommon mint `#5FF0A0`, Rare blue `#4F8BFF`, Epic purple `#A066FF`, Legendary orange `#FF9A3C`, Mythic gold `#F2C14E` or champagne `#F3DFA8` (lee to decide). These colours mark skin and chest tiers. Hull rarity itself is for lee to set.

Previews: `../../../../../docs/brand/turbo-skins/hulls-chrome.webp`, `hulls-overview.webp`, `hulls-sheet-<hull>.webp`, and `player-hulls-overview.webp`.

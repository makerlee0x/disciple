# Turbo skins, hulls, chests and weapons — previews

Contact sheets and mockups for draft PR #399. These files are here so they are not shipped to players from `web/public/`. The game sprites themselves live under `web/public/turbo/`.

Nothing is wired up. This folder is art review only.

Round 2 explosions, skin fixes, emblems, skies, opened chests, props and icons are in `r2/`.

## Game sprite folders

- `web/public/turbo/duel/skins/` — 10 rival skins for the original hull, plus trail colour notes
- `web/public/turbo/duel/skins/player/` — 18 player unlock skins for the original hull
- `web/public/turbo/duel/hulls/<hull>/` — chrome starter and 10 rival skins for each of 8 hulls
- `web/public/turbo/duel/hulls/<hull>/player/` — the same 18 player skins on each hull
- `web/public/turbo/royale/chests/` — six supply-drop crates and an opened state for every tier (opened Common through Mythic, and the champagne Mythic closed crate, are from round 2)
- `web/public/turbo/royale/weapons/` and `weapons/pods/` — 7 sci-fi weapons, windowed pods and glow layers
- `web/public/turbo/fx/` — explosion sprite sheets (round 2)
- `web/public/turbo/royale/maps/` — map emblems (round 2)
- `web/public/turbo/sky-hype.png` and `sky-sol.png` — vertical HYPE and SOL skies (round 2)
- `web/public/turbo/royale/` — also the storm wall, mothership and Last Pilot trophy (round 2)
- `web/public/turbo/icons/` — ammo, map and lock-on icons (round 2)

Silver chrome is the starter skin. Each hull's chrome file is that hull's starter. XP costs, chest prices and drop odds are left blank for lee.

## Previews in this folder

| File | What it is |
|---|---|
| `rival-skins-contact.webp` | The 10 rival skins on the original hull |
| `player-skins-contact.webp` | The 18 player unlock skins on the original hull |
| `hulls-chrome.webp` | Chrome starters for all 8 new hulls |
| `hulls-overview.webp` | All 8 hulls in chrome and a few rival skins |
| `hulls-trails.webp` | Trail colour mock on the new hulls |
| `hulls-sheet-<hull>.webp` | Chrome plus 10 rival skins for one hull |
| `player-hulls-overview.webp` | Player skins across the 8 hulls |
| `player-hulls-sheet-<hull>.webp` | All 18 player skins on one hull |
| `chests-contact.webp` | The six crates and the opened Legendary |
| `weapons-contact.webp` | The 7 weapons and their windowed pods |
| `weapons-scene-airdrop.webp` | Mid-flight mock: pods falling with the weapon visible |
| `weapons-swap-prompt.webp` | The 3-slot-full choice: swap into 1, 2 or 3, or keep |
| `weapons-hotbar.webp` | 3-slot hotbar mock |

`HANDOFF.md` has the open questions and the decisions already locked. `player_skins.md`, `chests.md` and `weapons.md` are the longer research and copy notes.

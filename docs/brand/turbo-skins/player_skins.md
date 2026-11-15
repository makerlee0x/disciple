# DISCIPLE player rocket skins (draft)

Player skins you unlock with XP, for Trading Duel and Turbo Royale. These are files only. Nothing is wired up, and no XP numbers or prices are set. The blanks are for lee to fill in.

Every skin uses the original in-game hull (same outline as `web/public/turbo/duel/rocket.webp`). Each one is a transparent 372×1024 PNG, lined up with the reference sprite and clipped to it. The sprites are in `web/public/turbo/duel/skins/player/`. The same 18 skins also exist on every new hull under `web/public/turbo/duel/hulls/<hull>/player/`.

---

## 1. What we based this on

| Game | Tiers, low → high | Rarity colours | What makes high tiers feel special |
|---|---|---|---|
| **Fortnite** | Common, Uncommon, Rare, Epic, Legendary, plus Mythic and Exotic for special items | grey, green, blue, purple, orange, gold (Mythic), light blue (Exotic) | Legendary skins get reactive and built-in styles. Epic Games removed visible cosmetic rarity in v29.20, but the colours are still what players expect. |
| **CS2** | Consumer, Industrial, Mil-Spec, Restricted, Classified, Covert, plus ★ knives and gloves and Contraband | `#b0c3d9` `#5e98d9` `#4b69ff` `#8847ff` `#d32ce6` `#eb4b4b`, Contraband `#e4ae39` | Wear levels (Factory New to Battle-Scarred) and rare pattern seeds. The rarest items get their own odds row. |
| **Apex Legends** | Common, Rare, Epic, Legendary, Mythic (also Iconic) | white, blue, purple, gold, red (turquoise for Iconic) | EA's guide: Common is a recolour, Rare adds textures, Epic adds moving parts, and Legendary and above change the model. |
| **Valorant** | Select, Deluxe, Premium, Exclusive, Ultra | blue, green, pink, orange, yellow | Higher editions add animations, sounds and effects, and some skins upgrade as you level them. |
| **Rocket League** | Common/Base, Uncommon/Sport, Rare/Special, Very Rare/Deluxe, Import, Exotic, Black Market | grey, light blue, blue, purple, red, yellow, magenta | Black Market items are animated decals and effects. Team colour always overrides the car's paint, so blue and orange stay readable. |

**Basis:** the ladder follows the shared grey → green → blue → purple → orange → gold order from Fortnite and Apex, which most players already know. How rich each tier looks follows Apex's and Valorant's steps: a recolour, then a pattern, then a material, then something that glows or moves, then a showpiece. The player-identity rule comes from Rocket League's team colour.

Sources: Fortnite Wiki "Rarity"; Veriloot CS2 rarity table (from items_game.txt); NeuralBoost and the Apex Legends Wiki "Cosmetic" page; thespike.gg and Dexerto on Valorant editions; Epic Games help page "Item Rarity Changes in Rocket League".

---

## 2. Tier ladder

| # | Plain name (recommended) | Themed name (option) | Rarity colour | What the tier looks like | XP to unlock |
|---|---|---|---|---|---|
| 1 | Common | Pilgrim | grey `#A7AFBE` | One solid paint colour, simple two-tone | ____ |
| 2 | Uncommon | Watchman | mint `#5FF0A0` | Bold patterns: stripes, checks, camo | ____ |
| 3 | Rare | Herald | blue `#4F8BFF` | Real materials: wood, porcelain, copper | ____ |
| 4 | Epic | Prophet | purple `#A066FF` | Glowing or gem finishes; could animate in code | ____ |
| 5 | Legendary | Archangel | orange `#FF9A3C` | Showpieces: deep space, angel feathers | ____ |
| 6 | Mythic | Glory | gold `#F2C14E` | One-of-a-kind top prize | ____ |

**Recommendation:** use the plain names in the UI, because players read "Epic" and "Legendary" instantly. The themed names could work as flavour text. They don't reuse any flight tier name; Morning Stars, Seraphim, Cherubim, Firmament, Throne Room and Heavenly Host are all already flight tiers.

Colour notes:
- There is no pink rarity colour, because pink means rivals. That's why CS2's Classified pink and Valorant's Premium pink are left out.
- Mythic uses brand gold `#F2C14E`, matching Fortnite Mythic, Apex Legendary and CS2 Contraband. Since gold also means "you", this needs lee's call. If he says no, Mythic could use champagne `#F3DFA8`.

Ideas for what could move in higher tiers (code effects for later, not built):
- Epic: the neon lines or lava glow slowly pulse.
- Legendary: the stars drift inside the nebula, and the halo rings shimmer.
- Mythic: a gold glint sweeps along the rocket after a win.

---

## 3. Skins (18)

| Tier | File | Name | What it looks like |
|---|---|---|---|
| Common | `player-common-white-gloss.png` | White Gloss | Clean white paint with grey fins and nose. The factory finish. |
| Common | `player-common-red-classic.png` | Red Classic | Shiny fire-engine red with white fins and a white nose. |
| Common | `player-common-sky-blue.png` | Sky Blue | Soft baby-blue body with a white nose and white fins. |
| Common | `player-common-safety-orange.png` | Safety Orange | Bright work-site orange with charcoal fins. |
| Common | `player-common-olive-drab.png` | Olive Drab | Flat army green with off-white tips, a little worn. |
| Uncommon | `player-uncommon-hazard.png` | Hazard | Satin black with yellow-and-black warning stripes on the fins. |
| Uncommon | `player-uncommon-checkered.png` | Checkered | White body with a black-and-white racing-flag nose and fins. |
| Uncommon | `player-uncommon-teal-racer.png` | Teal Racer | Deep teal with two white racing stripes down the middle. |
| Uncommon | `player-uncommon-arctic-camo.png` | Arctic Camo | White, blue-grey and slate splinter camo all over. |
| Rare | `player-rare-walnut-brass.png` | Walnut & Brass | Polished walnut wood with brass bands, rivets and nose. |
| Rare | `player-rare-delft-porcelain.png` | Delft | White porcelain hand-painted with blue flowers. |
| Rare | `player-rare-copper-verdigris.png` | Old Copper | Hammered copper going green at the seams. |
| Epic | `player-epic-neon-circuit.png` | Neon Circuit | Gloss black traced with glowing cyan and violet lines. |
| Epic | `player-epic-amethyst.png` | Amethyst | Faceted purple crystal set in silver. |
| Epic | `player-epic-molten.png` | Molten | Cracked black rock with lava glowing through. |
| Legendary | `player-legendary-nebula.png` | Nebula | A window into deep space, framed in mirror chrome. |
| Legendary | `player-legendary-seraph-wing.png` | Seraph Wing | Opal-white with feathered wing fins and glowing halo rings. |
| Mythic | `player-mythic-marble-gilt.png` | Marble & Gold Leaf | White marble with gold-filled veins and a gold-leaf nose. |

None of these is mostly pink. Gold appears only as an accent (Walnut's brass, Hazard's yellow) and as the main look of the single Mythic skin.

The contact sheet is `player-skins-contact.webp` in this folder. Raw generates and cutout scripts are not in the repo.

---

## 4. Keeping the player easy to spot in a non-gold skin

Today, gold means you and pink means rivals. Once a player can wear red, teal or marble, the rocket body can no longer carry "this is you". Games solve this by putting the identity marker outside the skin:
- **Rocket League:** team colour always overrides the paint.
- **League of Legends and other MOBAs:** your own character gets a gold/yellow ring and health bar.
- **Fortnite and Apex:** teammates get coloured outlines and name plates that the cosmetic can't change.

Proposal: the skin changes the body, and gold stays reserved for "you" everywhere else. In order of priority:
1. **Gold name tag.** Your tag is always `#F2C14E` and rivals' tags stay pink. This is the cheapest option and is already close to how the game works.
2. **Gold trail core.** Your exhaust always has a gold core, whatever skin you wear. Rivals keep the pink-side trails from `../trails.md`.
3. **Thin gold outline or ring.** A 1–2 px gold rim light, or a small gold chevron under your rocket, for crowded Turbo Royale screens.
4. **Rule for rival skins:** rivals never wear player skins, and player skins are never mostly pink. That keeps the two sides from blurring.

Open questions for lee: whether Mythic uses gold or champagne; plain or themed tier names; XP amount per tier (blank above); and whether players can also wear the default gold chrome as a "Classic" skin (recommended: yes, always unlocked).

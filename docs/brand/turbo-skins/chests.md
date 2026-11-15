# DISCIPLE supply drops: reward crates (draft mockups)

Reward crates for Trading Duel and Turbo Royale. These are files only: nothing is in the repo, and no odds, XP amounts or prices are set. The blanks are for lee.

**What lee asked for (Nov 15 2026):** "chests for winning or something like clash royale does. and have xp, or skins in there, or trails", then "no more like a supply drop chest. yeah it would open after a match. not timed. we need to mock up some chests then as well. like different chest give different drops."

---

## 1. What we based this on

| Source | What we took | What we left out |
|---|---|---|
| **Clash Royale** win chests | Winning earns a chest. Chests come in tiers, and each tier has different contents (better chests guarantee rarer cards). Chests can also be bought in the shop. | The unlock timers and limited chest slots. Lee wants each crate to open right after the match. |
| **Call of Duty** supply drops / care packages | The look: a rugged military cargo case with corner bumpers, handles and a strapped parachute pack. | Weapons and military markings. |
| **Apex Legends** care packages | The look: an armoured pod that lands, with tier-coloured light showing what is inside before it opens. | |
| **Fortnite** supply drops | A drop that arrives and opens in one go, with its rarity colour shown on the crate. | |

The crates are deliberately **not** treasure chests (no curved wooden lid, no lock clasp), because the profile already uses a treasure-chest icon for claiming fee rewards.

---

## 2. How you get crates

- **Earn:** winning a Trading Duel, or placing in Turbo Royale, drops a crate. Which tier you get per result is still open (blank for lee).
- **Buy with XP:** crates can also be bought with XP from launch.
- **Real money:** possibly later. If that happens, the drop odds for every crate must be published in-game first (as Clash Royale and Fortnite do, and as the Apple and Google app stores require for random rewards), and the local rules on paid random rewards need checking.
- **Opening:** the crate opens right after the match. There are no timers and no slots.
- **Duplicates:** any item you already own turns into XP.

---

## 3. The six crates

All six are the same cargo pod, shot from the same camera, getting richer per tier. Each one is a transparent 1024×1024 PNG.

| Tier | Colour | File | Look |
|---|---|---|---|
| Common | grey `#A7AFBE` | `chest-common.png` | Plain brushed-steel crate, grey parachute pack, soft white seam light. |
| Uncommon | mint `#5FF0A0` | `chest-uncommon.png` | Gunmetal and off-white two-tone with a bold diagonal stripe, mint seam lights. |
| Rare | blue `#4F8BFF` | `chest-rare.png` | Navy enamel with chrome bumpers, a glowing blue porthole and small chrome thrusters in the feet. |
| Epic | purple `#A066FF` | `chest-epic.png` | Gloss black with amethyst crystal corners, a glowing purple core and side thruster pods. |
| Legendary | orange `#FF9A3C` | `chest-legendary.png` | Pearl white and mirror chrome, an orange reactor-core window, chrome thruster feet, orange-strapped chute. |
| Mythic | gold `#F2C14E` | `chest-mythic.png` | White marble with gold filigree corners, small gold-and-white wings and a floating gold halo. |
| Legendary, opened | orange | `chest-legendary-open.png` | The lid pops up level on four pistons and orange light pours out. It is empty, so the items can be animated in code. |

**Mythic colour:** this uses brand gold for now. If lee keeps gold only for "you", Mythic switches to champagne `#F3DFA8`. That would mean recolouring the seam light and halo, while the gold filigree could stay.

---

## 4. What each crate can drop

These are content types only. Every odds figure and XP amount is left blank for lee.

Item types:
- **XP**
- **Player skins**, in the tiers from `../player/player_skins.md`
- **Player trails**: always a gold core, so you stay easy to spot. The pink trails are for rivals only and never drop.
- **Hulls**: bullet, needle, pulp, twin-booster, shuttle, hauler, ring-tail and wedge. Each one drops in its chrome starter finish, and your owned skins can then be worn on it.

| Crate | Always | Guaranteed item | Chance at | XP | Odds |
|---|---|---|---|---|---|
| Common | XP | none | 1 Common skin | ____ | ____ |
| Uncommon | XP | 1 item, Common or better (skin or trail) | an Uncommon skin, or the Mint Wake trail | ____ | ____ |
| Rare | XP | 1 item, Uncommon or better | a Rare skin, the Ice Wake trail, or a hull | ____ | ____ |
| Epic | XP | 1 item, Rare or better | an Epic skin, the Violet Arc trail, or a hull | ____ | ____ |
| Legendary | XP | 1 item, Epic or better, **plus** 1 hull or trail | a Legendary skin, or the Solar Flare trail | ____ | ____ |
| Mythic | the most XP | 2 items, 1 of them Legendary or better, **plus** 1 hull you don't own yet | Marble & Gold Leaf, the only Mythic skin | ____ | ____ |

Rules:
- The guaranteed item sets the floor. A higher crate can still roll lower-tier items for its other slots.
- Hulls start dropping at Rare. Lee could also give each hull its own rarity (for example, bullet and needle Rare, shuttle and wedge Legendary). This is open.
- Duplicates turn into XP.

### Proposed player trails (gold core → outer)

These are suggestions, not brand tokens. They avoid pink, which belongs to rivals.

| Name | Core → outer | Style | Drops from |
|---|---|---|---|
| Gold (starter) | `#F2C14E` → `#F3DFA8` | Today's player trail | Always unlocked |
| Mint Wake | `#F2C14E` → `#5FF0A0` | Soft, round puffs | Uncommon and up |
| Ice Wake | `#F2C14E` → `#8FB8FF` | Thin and fast | Rare and up |
| Violet Arc | `#F2C14E` → `#A066FF` | Electric flicker | Epic and up |
| Solar Flare | `#F2C14E` → `#FF9A3C` | Sparks that fall away | Legendary and up |

Orange was dropped for rivals because it sits too close to gold. On the player side that doesn't matter, since gold already means you.

---

## 5. Open questions for lee

1. Which crate tier does each result earn: Duel win, Royale 1st, top 3, and so on?
2. The XP price of each crate in the shop.
3. Drop odds and XP amounts for every crate (all blank above). They must be published in-game.
4. Whether real-money crates come later. If they do, odds must be published and local rules checked first.
5. Mythic colour: gold or champagne `#F3DFA8`.
6. Whether hulls get their own rarity, or every hull can drop from Rare up.
7. Whether each tier should get an opened state (only Legendary is mocked up), or whether code tints one shared open animation.

---

## 6. Files

- `chest-<tier>.png`: the six closed crates, transparent, 1024×1024
- `chest-legendary-open.png`: the opened state, transparent. The light is keyed as soft glow, so it looks right on the navy game background.
- `chests-contact.webp` (this folder): all six on navy `#121327`, with tier bars, drop lists and item thumbnails, plus the opened Legendary

The sprites themselves are in `web/public/turbo/royale/chests/`. Raw generates and cutout scripts are not in the repo.

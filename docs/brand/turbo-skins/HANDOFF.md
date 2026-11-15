# Rocket skins, hulls, chests and weapons: hand-off notes

Assets are in draft PR #399 on branch `brand/rival-skins`. Nothing is wired up, and this PR must stay a draft until lee says otherwise.

## Where the files are

- Rival skins (original hull): `web/public/turbo/duel/skins/`
- Player unlock skins (original hull): `web/public/turbo/duel/skins/player/`
- Eight new hulls, chrome + rival skins: `web/public/turbo/duel/hulls/<hull>/`
- Player unlock skins on each hull: `web/public/turbo/duel/hulls/<hull>/player/`
- Supply-drop chests: `web/public/turbo/royale/chests/`
- Royale weapons and pods: `web/public/turbo/royale/weapons/` and `weapons/pods/`
- Previews and these notes: `docs/brand/turbo-skins/`

## Defaults

- Silver chrome is the starter skin. Everyone has it unlocked, and each hull's chrome version is that hull's starter. The original hull's chrome is `web/public/turbo/duel/rocket.webp`.
- Rivals always wear pink-side skins. The player can wear any unlocked skin, and gold marks "you": a gold name tag and a gold core in your trail.

## Locked decisions (lee, 15 November 2026)

- Reward chests are Clash Royale-style supply drops (not treasure chests). They can drop XP, skins, hulls or trails. They open right after the match, with no timers and no slots. They are earned by winning, and can also be bought with XP from the start. Selling them for real money may come later.
- Players unlock hull shapes as well as skins and trails. The original hull is the starter shape. Any unlocked skin can go on any unlocked hull.
- Turbo Royale weapons stay sci-fi chrome, not real guns.
- Each air-drop pod shows its weapon inside a clear window. There is one pod per weapon.
- When all 3 weapon slots are full and the player touches a pod, they choose to swap into slot 1, 2 or 3, or keep what they have.

## Open decisions for lee

- Mythic tier colour: gold `#F2C14E` or champagne `#F3DFA8`.
- Tier names: plain (Common to Mythic) or themed (Pilgrim to Glory).
- XP cost for each skin tier, and the shop XP price of each crate.
- Drop odds and XP amounts for every chest tier. These must be published and must not be invented.
- Hull rarity: whether hulls get their own rarity, or every hull can drop from Rare up.
- Whether the shiny metal gold on Marble & Gold Leaf, Walnut & Brass and Seraph Wing is fine, or should be recolored away from "you" gold.
- Whether dark player skins (Hazard, Neon Circuit, Molten) need a thin light outline in-game.
- Per-map weapon pod drop rates.
- Whether the hotbar should use wider slots for long guns.
- Whether each chest tier should get an opened state (only Legendary is mocked up).
- Whether the machine gun and minigun, which share Rare/blue, are distinct enough by shape.

## Notes from looking at the sprites

- At in-game size, Hazard, Neon Circuit and Molten look dim on navy `#121327`.
- Seraph Wing and White Gloss look almost the same when small.
- The needle hull is so thin that every skin on it is hard to read.
- Long guns (sniper, rocket launcher, railgun) collapse to thin lines at 64 px. They read better in a wider slot.
- At in-flight pod size (about 200–300 px tall) most weapons read in the window. The sniper and rocket launcher are harder, especially in the darker epic shell. At 64–80 px you mainly see the parachute and the coloured capsule.

## Rarity colours

Common grey `#A7AFBE`, Uncommon mint `#5FF0A0`, Rare blue `#4F8BFF`, Epic purple `#A066FF`, Legendary orange `#FF9A3C`, Mythic gold `#F2C14E` or champagne `#F3DFA8`.

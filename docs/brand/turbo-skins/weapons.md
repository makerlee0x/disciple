# Turbo Royale: weapons and air drops (mockup, draft)

Files only. Nothing has been wired up.

Built from lee's design screenshot (as summarised in the original brief), his note that pods "float down and get discovered while people are flying", and his 15 November decisions: keep the sci-fi chrome weapons, show the weapon inside each pod, and when all 3 slots are full let the player choose to swap (pick a slot) or keep what they have.

## Assets

| File | What it is | Size |
|---|---|---|
| `weapon-pistol.png` | Starter weapon. Chrome raygun pistol with a grey-white cell. $10 × 1× | 1024×1024, transparent |
| `weapon-shotgun.png` | Uncommon. Stock, pump grip, bell muzzle, mint shell cells. $10 × 10× | 1024×1024, transparent |
| `weapon-machine-gun.png` | Rare. Curved mag, carry handle, holed shroud, blue mag glow. $3 × 33× | 1024×1024, transparent |
| `weapon-minigun.png` | Rare. Six-barrel gatling, drum, blue barrel rings. $1 × 100× | 1024×1024, transparent |
| `weapon-sniper.png` | Epic. Long barrel, scope, bipod, violet strip. $5 × 50× | 1024×1024, transparent |
| `weapon-rocket-launcher.png` | Epic. Bazooka tube, flared rear bell, warhead tip, violet glow. $10 × 50× | 1024×1024, transparent |
| `weapon-railgun.png` | Legendary. Bulky core body, forked twin rails, orange beam. $20 × 100× | 1024×1024, transparent |
| `airdrop-<weapon>.png` | Mid-flight pickup, one per weapon (7). Same parachute language as before, but the capsule is a wide display case with a clear glass window. The existing weapon sprite is composited inside, so it matches the hotbar icon exactly. Rarity colour on the parachute trim, frame lights and cavity. | 1024×1024, transparent |
| `airdrop-<weapon>-glow.png` | Separate soft halo + short downward beam in the weapon's rarity colour, aligned to the pod canvas, so code can pulse it | 1024×1024, transparent |
| `weapons-hotbar.webp` (this folder) | 3-slot hotbar (pistol, minigun, railgun), rarity frames, slot 1 selected, keys 1–3, size × leverage in Geist Mono | 1600×700 |
| `weapons-scene-airdrop.webp` (this folder) | In-flight mock: you (chrome starter, gold tag and trail core) and two pink-side rivals climbing. Three pods drift down with the weapon visible in each window (minigun, railgun, sniper). You are about to touch the railgun; slot 3 on the mini hotbar is empty. | 1920×1080 |
| `weapons-swap-prompt.webp` (this folder) | In-flight prompt when all 3 slots are full and you touch a pod. The sniper pod (weapon visible) sits ahead of you. The prompt shows Sniper $5 × 50× and two choices: swap with slot 1, 2 or 3, or keep yours. | 1920×1080 |
| `weapons-contact.webp` (this folder) | All 7 weapons with rarity bars, names and size × leverage, a 64 px hotbar row, and the 7 windowed pods with a small in-game-size thumbnail | 2390×1320 |


The weapon and pod sprites are in `web/public/turbo/royale/weapons/` and `weapons/pods/`. Empty shell bases, raw generates and scripts are not in the repo.

Weapon icons all face right and sit level, fitted to the same 940 px box. Since they're fitted by their longest side, the square pistol looks bigger than the long guns. If the hotbar should show the guns at one shared scale, that's a code choice.

Rarity colours are the approved ones: Common/start #A7AFBE, Uncommon #5FF0A0, Rare #4F8BFF, Epic #A066FF, Legendary #FF9A3C. Mythic gold isn't used on weapons or pods. Gold #F2C14E is only used for you (the player tag and trail core). Rival tags stay pink (#F0307F).

## Lee's decisions (15 November)

1. **Weapon art stays sci-fi chrome**, as in the current sprites. Not real guns.
2. **Each air-drop pod shows the weapon inside.** There is one pod per weapon (7), not one per rarity. Machine gun and minigun share the rare (blue) shell; sniper and rocket launcher share the epic (purple) shell. The weapon has to be readable through a clear window while the pod floats down on its parachute. The existing weapon sprites were composited into the window so they match the hotbar icons exactly. Glow stays a separate layer so code can pulse it.
3. **When all 3 slots are full and the player touches a pod, they choose.** They can swap (and pick which slot to replace with keys 1–3) or keep what they have. It is their choice. The prompt shows the new weapon with its size and leverage.

## How it was made

GenerateImage on flat light grey. The pistol came first and was used as the reference for the rest. The machine gun and sniper were then used as references for the long guns, because the pistol reference kept turning every weapon into a pistol (shotgun, launcher and railgun each took 2–3 tries).

The original closed pods (rarity only) used the approved reward crates as references. For this pass, those pods were used as style references to generate empty display-case shells: same parachute, cables, metal and rarity lighting, with a wide clear glass window and nothing inside. A first set of shells kept the tall narrow capsule, which left long guns unreadable; a second set widened the capsule into a horizontal display case. Cutouts are an IS-Net matte plus a background-difference matte to keep the parachute cables. Each existing weapon sprite was then composited into that shell's window (fit to the glass, soft shadow and a faint rarity glow in the cavity, original glass highlights laid back on top) so the gun in the pod matches the gun in the hotbar. The hotbar, glows, scene, swap prompt and sheet are composited in PIL from the real sprites (`ref-turbo-duel-rocket.webp`, `skin-candy-pink.png`, `skin-navy-chevron.png`).

## Research basis (how other games handle this)

- **Rarity-coloured loot:** Fortnite, Apex and PUBG all colour floor loot and pickups by tier (grey, green, blue, purple, orange), so players can judge an item before reaching it. We use the same order as the skins and crates.
- **Supply drops:** Fortnite supply drops float down under a balloon or parachute, and PUBG care packages drop by parachute with coloured smoke. Both can be seen from far away and are worth a detour. Our pods use the same idea mid-air: they drift down, and you steer into one to grab it.
- **Pickup beams:** Apex and Fortnite put a coloured light beam or glow on rare loot. That's why the glow is a separate layer that code can pulse or scale by tier.
- **Hotbar:** Fortnite's quick bar uses numbered slots with rarity-coloured slot backgrounds and a highlighted selected slot. The mock follows that and adds size × leverage under each name.
- **Full-inventory swap prompt:** Fortnite's floor-loot swap prompt and Apex's weapon pickup when both slots are full both show the new item mid-match and let you swap or leave it. In those games the swap usually replaces your currently selected or active weapon. Here the player also chooses which of the 3 slots to replace (keys 1–3), or keeps what they have — closer to Apex's death-box weapon replace, but shown in flight as a single prompt so it stays fast.

## Swap prompt copy (human pass)

Title: "All 3 slots are full"

Incoming line: the weapon name, then size × leverage, for example "Sniper  $5 × 50×"

Instruction: "Pick a slot to swap, or keep what you have."

Choices: slots 1, 2 and 3, each showing the weapon you would drop, and a quieter "Keep yours" action.

Hint: "Press 1, 2 or 3 to swap"

Plain words, no slang, no invented key for Keep. Gold is not used on this prompt; it stays on the YOU tag only.

The mock uses an incoming Sniper ($5 × 50×, Epic) against a full loadout of Pistol, Minigun and Railgun, so the choice is real — taking it means giving something up, and it isn't an obvious upgrade over the railgun already in slot 3.

## Notes from looking at the outputs

- At 64 px, the pistol, shotgun, machine gun and minigun read clearly. The sniper, rocket launcher and railgun turn into thin horizontal lines at that size. They still look different from each other (scope, tube, orange beam), but they read better in a wider slot (about 96×64) or with each icon scaled to the slot height.
- The machine gun and minigun are clearly different: the minigun has a drum and a barrel cluster, the machine gun a curved mag. They share the blue colour, though, so at a glance shape does all the work.
- Weapon art is sci-fi chrome (raygun family), not real guns. Locked 15 November.
- **Pods with the weapon visible:** at in-flight size (about 200–300 px tall) the pistol, shotgun, machine gun, minigun and railgun read clearly in the window. The sniper and rocket launcher are thinner and harder, especially the rocket launcher (a long tube) and anything in the epic (purple) shell, whose window is darker and slightly smaller because of the double frame. You can still tell they are long guns, and the pod's rarity colour does some of the work. At 64–80 px tall, the weapon inside is no longer readable; you mainly see the parachute and the coloured capsule. If pods will often be that small on screen, a stronger silhouette or a slightly larger window on the epic shell would help.
- The legendary pod is wider than the others because of the side wings. At a shared height it still lines up with the family.

## Open questions

1. The machine gun and minigun are both Rare and both blue. Is the shape difference enough, or should one change?
2. Should the hotbar keep one slot shape and scale long guns to the slot height, or use wider slots?
3. How far apart should pods drop, and should rarer pods drop less often or further out? Loot depends on the map, so this needs a per-map table.
4. The epic window is the darkest and smallest, and it holds the two thinnest guns (sniper and rocket launcher). If those two don't read well enough in flight, the epic shell could get a slightly larger, lighter window.

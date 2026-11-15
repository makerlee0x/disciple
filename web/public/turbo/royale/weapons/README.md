# Turbo Royale weapons and air-drop pods

Seven sci-fi chrome weapons, and one air-drop pod for each weapon with that weapon visible inside. Glow is a separate layer so code can pulse it.

These are files only. Nothing is wired up.

Each weapon and pod file is a transparent 1024×1024 PNG. Weapons face right and sit level. Files are named `weapon-<name>.png`. Pods and glows live in `pods/` as `airdrop-<name>.png` and `airdrop-<name>-glow.png`.

| Weapon | File | Tier and colour | Size × leverage |
|---|---|---|---|
| Pistol | `weapon-pistol.png` | Common / starter, grey `#A7AFBE` | $10 × 1× |
| Shotgun | `weapon-shotgun.png` | Uncommon, mint `#5FF0A0` | $10 × 10× |
| Machine gun | `weapon-machine-gun.png` | Rare, blue `#4F8BFF` | $3 × 33× |
| Minigun | `weapon-minigun.png` | Rare, blue `#4F8BFF` | $1 × 100× |
| Sniper | `weapon-sniper.png` | Epic, purple `#A066FF` | $5 × 50× |
| Rocket launcher | `weapon-rocket-launcher.png` | Epic, purple `#A066FF` | $10 × 50× |
| Railgun | `weapon-railgun.png` | Legendary, orange `#FF9A3C` | $20 × 100× |

Mythic gold is not used on weapons or pods. Gold `#F2C14E` stays reserved for the player (name tag and trail core).

## Lee's decisions (15 November 2026)

The guns stay sci-fi chrome, not real guns. Each pod is a wide display case with a clear window, and the matching weapon sprite sits inside so it matches the hotbar icon. There is one pod per weapon (seven), not one per rarity. The machine gun and minigun share the rare (blue) shell; the sniper and rocket launcher share the epic (purple) shell.

The player has 3 weapon slots. When all 3 are full and they touch a pod, they choose: swap into slot 1, 2 or 3, or keep what they have.

## Left blank for lee

Drop rates are not set. Loot depends on the map, so this needs a per-map table. Whether the hotbar should use wider slots for long guns is also open. Shop prices and XP costs do not apply here; these are mid-flight pickups.

Previews: `../../../../../docs/brand/turbo-skins/weapons-contact.webp`, `weapons-scene-airdrop.webp`, `weapons-swap-prompt.webp` and `weapons-hotbar.webp`.

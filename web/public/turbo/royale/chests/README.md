# Reward chests (supply drops)

Six closed supply-drop crates, one per rarity, and an opened state for every tier. They look like cargo pods with a parachute pack and tier-coloured seam lights, not treasure chests. The look comes from Call of Duty supply drops, Apex care packages and Fortnite supply drops. The idea comes from Clash Royale's tiered win chests, but without unlock timers.

These are files only. Nothing is wired up.

Each file is a transparent 1024×1024 PNG. Opened crates have the lid up, with light spilling out in the tier colour.

Mythic is champagne `#F3DFA8`. The closed `chest-mythic.png` in this folder is the champagne version.

| File | Tier | Colour |
|---|---|---|
| `chest-common.png` | Common | grey `#A7AFBE` |
| `chest-uncommon.png` | Uncommon | mint `#5FF0A0` |
| `chest-rare.png` | Rare | blue `#4F8BFF` |
| `chest-epic.png` | Epic | purple `#A066FF` |
| `chest-legendary.png` | Legendary | orange `#FF9A3C` |
| `chest-mythic.png` | Mythic | champagne `#F3DFA8` |
| `chest-common-open.png` | Common, opened | grey glow |
| `chest-uncommon-open.png` | Uncommon, opened | mint glow |
| `chest-rare-open.png` | Rare, opened | blue glow |
| `chest-epic-open.png` | Epic, opened | purple glow. The glow is weaker than the other opened crates. |
| `chest-legendary-open.png` | Legendary, opened | orange glow, keyed for the navy game background |
| `chest-mythic-open.png` | Mythic, opened | champagne glow |

## How they work (decided)

Crates open right after the match. There are no timers and no slots. Winning a Trading Duel or placing in Turbo Royale earns a chest. They can also be bought with XP from the start, like Clash Royale's shop chests. Selling them for real money may come later.

A chest can drop XP, a skin, a hull or a trail. Higher-tier chests have better odds of rarer items. Duplicates turn into XP.

## Left blank for lee

XP costs, shop prices, drop odds and XP amounts are not set, and must not be invented. Every chest tier needs published drop odds (item type and rarity) before anything ships. Plain vs themed tier names are still open.

Closed crates contact sheet: `../../../../../docs/brand/turbo-skins/chests-contact.webp`. Opened crates and the champagne Mythic: `../../../../../docs/brand/turbo-skins/r2/chests.webp`.

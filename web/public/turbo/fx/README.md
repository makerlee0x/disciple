# Explosion sprite sheets

Sprite sheets for Trading Duel and Turbo Royale: the NUKE, a gun breaking, a pod opening, a small blast, a cash-out burst, and five bomb-tier blasts. These are files only. Nothing is wired up.

Every sheet is one horizontal row of square 512×512 frames on a transparent background. The effect is centred on the same point in every frame so the blast does not jump. That centre is 256,256 on every sheet except `fx-pod-open.png`, where the pod body sits at 256,292 and the beam rises from the window. The outer 6 px of every frame is fully transparent, so nothing touches the edge. Downscale in code.

| File | Frames | Used for |
|---|---|---|
| `fx-nuke.png` | 10 | NUKE (liquidation) in every mode. White flash, then a pink and orange fireball, a shockwave ring, then a smoke mushroom. |
| `fx-weapon-break.png` | 6 | The gun blows up on a NUKE. A chrome railgun shatters into glowing shards with a small spark burst. |
| `fx-pod-open.png` | 6 | Picking up loot. A supply pod's doors burst open with a beam of white light, to be tinted by rarity in code. |
| `fx-boom-small.png` | 6 | Losing a dogfight or getting knocked out. A small orange and pink blast with quick sparks. |
| `fx-cashout.png` | 6 | Cashing out in profit. A burst of mint `#5FF0A0` sparkles and plain discs of light, with no coins or symbols. |
| `fx-grenade.png` | 8 | Smallest bomb tier. The NUKE sequence at 0.40 of its size, as a puff of smoke rather than a mushroom. |
| `fx-bunker-buster.png` | 8 | Next bomb tier, at 0.52 of the NUKE. |
| `fx-warhead.png` | 8 | Mid bomb tier, at 0.64 of the NUKE. |
| `fx-moab.png` | 8 | Large bomb tier, at 0.76 of the NUKE, with a mushroom. |
| `fx-atom-bomb.png` | 8 | Just under the NUKE, at 0.88 of its size, with a mushroom. The NUKE is the biggest. |

The five bomb-tier sheets are the NUKE scaled down inside the same 512 px frame, a little brighter at each step. Render every tier at one sprite size in game; the size difference is already in the art.

The early white flash on the NUKE hides the fireball for a couple of frames. The mushroom is a violet grey rather than truly dark, because black smoke disappeared on navy `#121327`.

Preview GIFs and contact sheets (on navy `#121327`): `../../../../docs/brand/turbo-skins/r2/`.

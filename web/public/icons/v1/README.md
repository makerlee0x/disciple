# DISCIPLE icons v1

51 icons + the bomb-tier orb meter (`meter-orbs-1…6`). Monoline, 24px grid, 1.5px stroke, round caps/joins, `currentColor` only.

## Use
**Sprite:** inline `sprite.svg` once (hidden) in the page, then:
```html
<svg width="20" height="20" aria-hidden="true"><use href="#d-boost"/></svg>
```
Ids are `d-<name>` (file names without `.svg`, e.g. `d-home`, `d-bomb-bunker`, `d-meter-orbs-3`).

**Single files:** `svg/<name>.svg`, imported as an SVG component or inlined.

## Color
Icons use `stroke/fill="currentColor"`, so set color with CSS `color`. They inherit text color (#E8EAEE / muted #9095A0). Semantic colors only: up #5FF0A0 (BOOST), down #F0307F (DUMP, bombs), orange #FF7A3D (one signal per view). No gold.

## Sizes
16, 20 and 24px (24 is native). Larger sizes are fine for display use. Don't change the stroke width.

## Bomb tiers
`bomb-puff`, `bomb-grenade`, `bomb-bunker`, `bomb-cruise`, `bomb-nuke`, `bomb-atom`. Tier is set purely by price impact: PUFF <2% · GRENADE 2–5% · BUNKER 5–12% · CRUISE 12–25% · NUKE 25–50% · ATOM ≥50%.
Orb meter `meter-orbs-N` (N = tier 1–6): 6 orbs, reached = solid, unreached = thin outline. The artwork is 40×16 (viewBox 0 0 40 16); set it at 16px height in-line after the bomb icon, width 40px.
Generic `bomb` and `nuke` remain for non-tier use.

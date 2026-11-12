# DISCIPLE brand v3: light on film

Brand v3 adds a game layer on top of v1 and v2. It is additive: no existing `--dsc-*` token changes value, so nothing on the site moves until a screen opts in.

- Tokens and classes: [`web/app/brand-tokens-v3.css`](../web/app/brand-tokens-v3.css) (classes are prefixed `.dsc3-`)
- Reference page: `/dev/brand` (runs under `next dev` only)
- Direction and positioning: the "Disciple UI/UX refresh: direction" doc

## The idea

The moodboard sets the **atmosphere**: film grain, soft bloom, deep night sky, chrome under hard light. Game menus set the **structure**: a lobby tab bar, shop shelves, a garage turntable, mission bars.

## Rules

1. **Grain everywhere.** Every hero and page background gets `.dsc3-grain`.
2. **Bloom, not glow.** One soft light source per hero (`.dsc3-bloom`, `.dsc3-beam`). No neon outlines, no purple gradients, no gradient text.
3. **The hero object stands on something.** Rockets sit on `.dsc3-stand` with a contact shadow. Nothing floats.
4. **Gold is the one main action.** One `.dsc3-btn-primary` per screen. Everything else is white, ghost or a chip.
5. **Each signal colour means one thing.** Up is climbing and gains, down is dumps and losses, info is neutral live data.
6. **Game type for headings and numbers, Geist for reading.** Barlow Condensed (`--dsc-font-game`, Tailwind `font-game`), uppercase, for headings, buttons and stats. Body copy stays Geist. Mono only for small data labels.
7. **Short copy.** Labels are one to three words, buttons are verbs, and a line of body copy doesn't wrap twice. No emoji, no "New ✨" badges.
8. **44px minimum** for anything you can tap.

## Difficulty

| Badge | Contract mode | Class |
| --- | --- | --- |
| Easy | PVE | `.dsc3-badge-easy` |
| Hard | PVP | `.dsc3-badge-hard` |
| Expert (nickname "Trench") | TRENCH | `.dsc3-badge-expert` |
| In orbit | any, after graduation | `.dsc3-badge-orbit` |

The limits only apply on the curve, so a graduated rocket shows **In orbit** instead of its difficulty.

## Word list

| Say | Not |
| --- | --- |
| Rocket | Token, coin |
| Call sign | Ticker |
| Launch | Deploy, create token |
| Boost | Buy |
| Dump | Sell |
| Altitude | Market cap |
| Crew | Holders |
| Pilot | Wallet, user |
| Reach orbit, graduate | Migrate |
| Hangar | Portfolio |

Disclosure still applies (see [product-ux.md](product-ux.md)). The confirm step names the real token, the pair and the $ amount before any money moves.

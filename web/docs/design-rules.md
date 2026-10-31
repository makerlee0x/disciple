# DISCIPLE design rules

Shared dashboard UI. Pass 1. Two other teams follow this.

The game skin is exempt. See the bottom.

## Surfaces

Flat fill, 1px border. No glow. No decorative gradient.

Use `--dsc-bg`, `--dsc-surface`, or `--dsc-surface-2`, with `border: 1px solid var(--dsc-border)`.

## Accent

One accent: gold, `--dsc-gold` (`#F2C14E`).

Gold is only the single primary action. That is the claim button, and the shared primary classes `.cl-btn.primary`, `.cl-btn.gold`, and `.ds-btn.gold`. Flat fill, no gradient, no glow. On `/creator`, Claim all and Claim creator fees are the same button.

Do not put gold on cards, numbers, borders, text, or chips.

`--dsc-medal-1-fill` still points at gold for the rank-1 medal. That is an existing status fill. Do not add new gold from it.

Buy and sell stay `--dsc-up` and `--dsc-down`. They are not the gold accent.

## Titles

Sentence case. "Your rockets", not "YOUR ROCKETS".

## Chips

A chip is for an exception or a status (sample data, pending, approved, live). Not decoration.

## Icons

No emoji as icons. Use the icon set.

## Words

Plain words.

## Spacing

4px scale. Padding and margin use these tokens. If a value is equally close to two steps, use the smaller step.

| Token | Value |
| --- | --- |
| `--dsc-space-0` | 0 |
| `--dsc-space-px` | 1px |
| `--dsc-space-0-5` | 2px |
| `--dsc-space-1` | 4px |
| `--dsc-space-2` | 8px |
| `--dsc-space-3` | 12px |
| `--dsc-space-4` | 16px |
| `--dsc-space-5` | 20px |
| `--dsc-space-6` | 24px |
| `--dsc-space-8` | 32px |
| `--dsc-space-10` | 40px |
| `--dsc-space-12` | 48px |
| `--dsc-space-16` | 64px |
| `--dsc-space-20` | 80px |
| `--dsc-space-24` | 96px |
| `--dsc-space-32` | 128px |

## Radius

Three steps. Map any other radius to the nearest.

| Token | Value |
| --- | --- |
| `--dsc-radius-6` | 6px |
| `--dsc-radius-12` | 12px |
| `--dsc-radius-full` | 9999px |

Circles and pills use `--dsc-radius-full`.

Older names (`--dsc-radius-xs` through `--dsc-radius-4xl`) still resolve so existing component CSS does not break. New CSS uses the three steps. Do not add steps.

## Focus

`--dsc-glow-focus-ring` stays. It is a focus outline, not a glow.

## Exempt

Leave the game skin as it is:

- Pixel and retro fonts
- The rocket, clouds, and bombs
- Sky colors and tier sky art
- `web/public/flight/engine.js` and the game HUD
- Hero scrims over the sky (`--dsc-gradient-scrim-top`, `--dsc-gradient-scrim-side`, and the home scrim)
- Hangar and launch-scene art: stage grid, door, floor, exhaust trail, flame, staging room, star field, launch tower, pad block, tier-sky placeholder
- Hangar frame skins (pearly, winged)
- Pair-art geometry (the `.pa` masks)
- The select caret (two hard-edge gradients that draw the arrow)

`--dsc-gradient-ascent` and `--dsc-gradient-signature` stay in the token file. They are the sky ramp and the brand stripe, not dashboard chrome.

# Sound effects (v1)

Sound effects for flight and Turbo: boosts, engine loops, lever clicks, explosions, nukes, pod drops, weapon pickups, cash-out and more. Nothing in the game uses them yet; wiring them in is a separate step.

## Every sound is CC0

Every source is public domain (CC0 1.0): Freesound uploads marked "Creative Commons 0" and Kenney packs (CC0). No credit is required. `SOURCES.csv` is our record of where each layer came from (source URL, author, license, and what we did to it), so we can show the license if anyone asks.

## Files

- `*.m4a`: 42 files, AAC, 48 kHz. Mono, except `engine_loop`, the explosions and the nukes, which are stereo. Starts are trimmed tight so they fire on the frame.
- `loops-wav/`: gapless 16-bit WAV copies of the four looping sounds (`engine_loop`, `engine_loop_alt`, `nuke_warning_01`, `nuke_warning_02`). AAC adds a tiny gap at the loop point, so use these WAVs when a sound loops (Web Audio `loop = true`), and the .m4a for everything else.
- Names ending `_01`, `_02`, `_03` are takes of the same sound; pick one at random so repeats don't sound identical.

## Loudness

- One-shots: about -16 LUFS (very short clicks and hits are matched by peak instead).
- Loops and crew boosts: about -20 LUFS, so they sit under the one-shots.
- True peak at or below -1 dBTP. Everything was checked on phone speakers, so the low-mid punch is kept.

The full-quality originals and the edit recipes are kept outside the repo.

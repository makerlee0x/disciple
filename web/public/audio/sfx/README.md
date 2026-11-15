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

## v3 batch 2: the fights

20 sounds for Turbo Royale, the Trading Duel and trade confirmations. They're all CC0, from Freesound and Kenney, and each source is listed in `SOURCES.csv`.

- Royale guns: `gun_pistol_01/02`, `gun_machine_01/02` (one burst each), `gun_minigun` (spin-up, fire and spin-down as one shot), `gun_minigun_loop` (the firing part as a 2.000 s loop for holding the trigger), `gun_shotgun_01/02`, `gun_sniper`, `gun_rocket` and `gun_railgun`. They're sci-fi energy weapons, not real guns.
- Royale hits: `hit_marker_01/02`, a tight metallic tick.
- Duel: `match_found`, `countdown_beep` (one beep used for 3, 2 and 1) and `race_go`.
- Trading: `trade_fill_buy`, `trade_fill_sell`, `tx_fail` and `ath_reached` (new all-time high).
- `loops-wav/gun_minigun_loop.wav` is the gapless copy to use when the minigun loops.
- Loudness is the same as before. One-shots and stings sit around -16 LUFS. Short clicks like the hit marker, beep, buy chime and fail are matched by peak. True peak is at or below -1 dBTP.

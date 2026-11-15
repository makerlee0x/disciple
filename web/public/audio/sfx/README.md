# Sound effects

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

## v3 batch 1: menus and crates

23 more files from the v3 brief, same rules (all CC0, no credit needed, rows added to `SOURCES.csv` with `brief_no` = `v3 batch 1`):

- Taps: `ui_tap_01`-`03`, `ui_tap_primary` (PLAY, LAUNCH, FIND A MATCH), `ui_back_01`-`02`. One family: a tapped wire sculpture, soft and a little metallic.
- Sheets and mode cards: `sheet_open`, `sheet_close`, `mode_swipe_01`-`03`, `mode_snap_01`-`02`, `mode_select`.
- Crates: `crate_land_01`-`02`, `crate_shake` (builds into the open), `crate_open`, then `reveal_common`, `reveal_rare`, `reveal_epic`, `reveal_legendary`, `reveal_mythic`.
- Levels: UI sounds are quiet on purpose (peaks around -3 to -6 dBFS, about 6 dB under the one-shots). Crates and reveals sit at about -16 LUFS like the flight one-shots. Every file is under 0.45 s (UI) or 2.5 s (stings). Mono, except the epic, legendary and mythic reveals.

The ambience beds from the same batch are in `../amb/`.

The full-quality originals and the edit recipes are kept outside the repo.

## v3 batch 2: the fights

20 sounds for Turbo Royale, the Trading Duel and trade confirmations. They're all CC0, from Freesound and Kenney, and each source is listed in `SOURCES.csv`.

- Royale guns: `gun_pistol_01/02`, `gun_machine_01/02` (one burst each), `gun_minigun` (spin-up, fire and spin-down as one shot), `gun_minigun_loop` (the firing part as a 2.000 s loop for holding the trigger), `gun_shotgun_01/02`, `gun_sniper`, `gun_rocket` and `gun_railgun`. They're sci-fi energy weapons, not real guns.
- Royale hits: `hit_marker_01/02`, a tight metallic tick.
- Duel: `match_found`, `countdown_beep` (one beep used for 3, 2 and 1) and `race_go`.
- Trading: `trade_fill_buy`, `trade_fill_sell`, `tx_fail` and `ath_reached` (new all-time high).
- `loops-wav/gun_minigun_loop.wav` is the gapless copy to use when the minigun loops.
- Loudness is the same as before. One-shots and stings sit around -16 LUFS. Short clicks like the hit marker, beep, buy chime and fail are matched by peak. True peak is at or below -1 dBTP.
## v3 batch 3, P2 and P3: money, menus and the rest

51 sounds and 4 ambience beds. That covers batch 3 of the v3 brief plus every P2 and P3 sound. They're all CC0, from Freesound and Kenney, and each source is listed in `SOURCES.csv`.

- Money and launches: `deposit_start`, `deposit_done`, `withdraw_sent`, `balance_tick`, `fee_claim`, `launch_ignite`, `launch_liftoff`, `signin_welcome`
- Progress: `level_up`, `rank_up`, `mission_done`, `trophy_unlock`, `streak_up`, `xp_tick`, `skin_equip`
- Menus: `ui_success`, `ui_error`, `ui_toggle_on`, `ui_toggle_off`, `ui_tab`, `ui_slider_tick`, `ui_refresh`, `toast_in`, `chat_ping`
- Royale: `shield_hit`, `shield_break`, `gun_empty`, `drop_in`, `map_jump`, `storm_warning`, `zone_shrink`, `knock_feed`, `royale_out_sting`
- Duel: `ready_lock`, `lead_swap`, `overtime_horn`, `duel_lose_sting`, `rating_up`, `rating_down`, `share_shutter`
- Main flight: `tx_pending` (a soft 1.900 s loop), `rug_alarm`, `whale_pass`, `trick_whoosh`, `steer_whoosh` (levelled very quiet on purpose), `crew_join`
- Dump bombs, smallest to biggest: `bomb_grenade`, `bomb_bunker`, `bomb_warhead`, `bomb_moab`, `bomb_atom`
- `loops-wav/tx_pending.wav` is the gapless copy to use when the pending sound loops.

### Ambience in `../amb/`

| File | Where it plays | Loop length |
| --- | --- | --- |
| `amb_orbit_hum.m4a` | Flight once you climb high or hit a new high | 90.000 s |
| `amb_hangar.m4a` | Hangar, Rocket Factory, crate opening (mono) | 84.000 s |
| `amb_mission_control.m4a` | Duel and Royale lobbies, waiting for a rival | 57.000 s |
| `amb_tension.m4a` | Royale final circle, Duel overtime | 57.000 s |
| `amb_mothership_pass.m4a` | Royale drop-in. This one is a 7.5 s one-shot, not a loop | — |

The beds are levelled to about -23 LUFS. AAC pads the end of each file with a few milliseconds of silence, so loop them in Web Audio with `loopEnd` set to the loop length above.

Loudness is otherwise the same as before. One-shots and stings sit around -16 LUFS, short UI clicks are matched by peak, and true peak is at or below -1 dBTP.

# Ambience beds

Quiet space beds that play under the music so the app never goes silent. All CC0 (Freesound), no credit needed. The source and license record is in `../sfx/SOURCES.csv` (rows whose file starts with `../amb/`).

| File | Where it plays | Loop length |
| --- | --- | --- |
| `amb_space_drone.m4a` | Lobby, menus, Settings, Wallet | 93.000 s |
| `amb_wind_high.m4a` | Every flight, low on the chart (crossfade to the space drone as you climb) | 58.000 s |
| `amb_storm_wall.m4a` | Royale, while the storm is on screen | 72.000 s |

- Stereo AAC, 48 kHz, 160 kbps, levelled to about -23 LUFS so they sit under the music and the one-shots.
- Each file is a seamless loop: the end flows straight into the start. AAC pads the end of the file with a few milliseconds of silence, so for a clean seam loop it in Web Audio with `loop = true`, `loopStart = 0` and `loopEnd` set to the loop length above, rather than relying on the file's own end.

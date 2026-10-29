# Guild logos (placeholders only)

Our own hosted copies of starter guild logos live here as `<guild id>.png` (for example `g-pepe.png`). They are never hotlinked.

Nothing is committed yet. Until lee has reviewed each logo and its licensing, `GUILD_LOGOS_COMMITTED` in `lib/guildSeed.ts` stays `false`, and every guild shows its lettered placeholder in the 24×24 slot.

To fetch logos for review, run `npx tsx scripts/fetch-guild-logos.mts --out=<review dir>`. Copy the approved files here, then flip the flag.

BRAND's shared frame is a separate overlay (`GUILD_FRAME_SRC`), not baked into these files.

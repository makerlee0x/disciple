"use client";

import { useEffect, useState } from "react";
import { withBase } from "@/lib/base-path";
import { GUILD_COPY, type GuildTag } from "@/lib/guilds";
import { GUILDS_EVENT, cachedGuild, lookupGuild } from "@/lib/guildClient";
import { GUILD_FRAME_SRC } from "@/lib/guildSeed";
import { PROFILE_CHANGED_EVENT } from "@/lib/profile";

/**
 * 24×24 mark slot (BRAND guilds-r1). Two layers, both swappable:
 *  - the logo: our own hosted copy under public/guilds/<id>.png (never hotlinked; lib/guildSeed GUILD_LOGOS_COMMITTED),
 *    or the tag's first letter when there is no logo or it fails to load;
 *  - the BRAND frame: a separate overlay image (GUILD_FRAME_SRC) so every coin logo sits in one consistent frame; until
 *    BRAND ships it, a CSS ring stands in.
 */
export function GuildMark({ guild, size = 24 }: { guild: Pick<GuildTag, "tag" | "mark">; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [guild.mark]);
  const style = { width: size, height: size, flex: `0 0 ${size}px` } as const;
  const logo = guild.mark && !broken;
  return (
    <span className={`guild-mark${GUILD_FRAME_SRC ? "" : " guild-mark-ring"}`} style={style} aria-hidden>
      {logo
        ? /* eslint-disable-next-line @next/next/no-img-element */
          <img className="guild-mark-logo" src={withBase(guild.mark)} alt="" width={size} height={size} onError={() => setBroken(true)} />
        : <span className="guild-mark-letter" style={{ fontSize: Math.round(size * 0.55) }}>{guild.tag.slice(0, 1)}</span>}
      {GUILD_FRAME_SRC && /* eslint-disable-next-line @next/next/no-img-element */
        <img className="guild-mark-frame" src={withBase(GUILD_FRAME_SRC)} alt="" width={size} height={size} />}
    </span>
  );
}

/**
 * Guild tag chip (BRAND guilds-r1): inline (mark + TAG, next to names in feeds/lists), md / lg ("GUILD" + TAG: profile).
 * Marks render at 12px+ only; below that, the text alone.
 */
export default function GuildChip({ guild, size = "inline" }: { guild: Pick<GuildTag, "tag" | "mark"> | null | undefined; size?: "inline" | "md" | "lg" }) {
  if (!guild) return null;
  const px = size === "lg" ? 16 : size === "md" ? 14 : 12;
  return (
    <span className={`guild-chip guild-chip-${size}`} title={GUILD_COPY.wear(guild.tag)} data-testid="guild-chip">
      <GuildMark guild={guild} size={px} />
      {size !== "inline" && <span className="guild-chip-word">GUILD</span>}
      <span className="guild-chip-tag">{guild.tag}</span>
    </span>
  );
}

/** The guild tag of `address`, live: refreshes when this browser changes guilds or GAME/SITE publish new tags. */
export function useGuildTag(address: string | null | undefined): GuildTag | null {
  const [tag, setTag] = useState<GuildTag | null>(() => cachedGuild(address) ?? null);
  useEffect(() => {
    let alive = true;
    const load = () => void lookupGuild(address).then((t) => { if (alive) setTag(t); });
    setTag(cachedGuild(address) ?? null); load();
    const onGuilds = (e: Event) => {
      const m = (e as CustomEvent<Record<string, GuildTag | null>>).detail;
      if (address && m && address.toLowerCase() in m) setTag(m[address.toLowerCase()] ?? null);
    };
    window.addEventListener(GUILDS_EVENT, onGuilds);
    window.addEventListener(PROFILE_CHANGED_EVENT, load);
    return () => { alive = false; window.removeEventListener(GUILDS_EVENT, onGuilds); window.removeEventListener(PROFILE_CHANGED_EVENT, load); };
  }, [address]);
  return tag;
}

/** Inline chip for a wallet (looks the tag up). Renders nothing when the wallet has no guild. */
export function GuildTagFor({ address, size = "inline" }: { address: string | null | undefined; size?: "inline" | "md" | "lg" }) {
  const tag = useGuildTag(address);
  return <GuildChip guild={tag} size={size} />;
}

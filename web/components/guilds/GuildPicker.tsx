"use client";

import { useEffect, useMemo, useState } from "react";
import { GUILD_COPY as C, GUILD_NAME_MAX, GUILD_TAG_MAX, normalizeTag, type Guild } from "@/lib/guilds";
import { GUILD_CATEGORIES } from "@/lib/guildSeed";
import { createGuild, fetchMyGuild, findGuildByTag, joinGuild, leaveGuild, listGuilds, type GuildActionResult } from "@/lib/guildClient";
import { formatLocalWhen } from "@/lib/usernameCooldown";
import GuildChip, { GuildMark } from "./GuildChip";

/**
 * Guild row in Edit profile (replaces the community part of the old flag picker). Acts right away (its own signed
 * write per action, /api/guilds), separate from the profile Save. One guild per player; switching is once a day.
 * Starter guilds are lib/guildSeed (lee's 12 in 3 categories, swappable), grouped by category; player-made guilds after. "Start a guild" needs a claimed username.
 */
export default function GuildPicker({ wallet, hasUsername }: { wallet: string | null; hasUsername: boolean }) {
  const [mine, setMine] = useState<Guild | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [all, setAll] = useState<Guild[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Guild | null>(null);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchMyGuild(wallet).then((r) => { if (alive) { setMine(r.guild); setNextAt(r.nextSwitchAt); } });
    return () => { alive = false; };
  }, [wallet]);
  useEffect(() => { if (open && !all.length) void listGuilds().then(setAll); }, [open, all.length]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => all.filter((c) => !needle || c.tag.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)), [all, needle]);
  useEffect(() => {
    setFound(null);
    const t = normalizeTag(q);
    if (t.length < 2 || all.some((c) => c.tag === t)) return;
    const h = setTimeout(() => void findGuildByTag(t).then(setFound), 300);
    return () => clearTimeout(h);
  }, [q, all]);

  const locked = !!mine && nextAt != null && nextAt > Date.now();
  const done = (r: GuildActionResult, ok: string) => {
    if (r.ok) { setMine(r.guild); setMsg({ ok: true, text: ok }); setAll([]); setOpen(false); setStarting(false); void fetchMyGuild(wallet).then((x) => setNextAt(x.nextSwitchAt)); }
    else setMsg({ ok: false, text: r.reason === "wait" && r.nextAllowedAt ? C.wait(formatLocalWhen(r.nextAllowedAt)) : r.reason });
  };
  const join = async (c: Guild) => { setBusy(c.id); setMsg(null); done(await joinGuild(c.id, wallet), C.joined); setBusy(""); };
  const leave = async () => { setBusy("leave"); setMsg(null); done(await leaveGuild(wallet), C.none); setBusy(""); };
  const start = async () => { setBusy("create"); setMsg(null); done(await createGuild(tag, name, wallet), C.joined); setBusy(""); };

  const Opt = ({ c }: { c: Guild }) => (
    <button type="button" className={`guild-opt ${mine?.id === c.id ? "on" : ""}`} aria-pressed={mine?.id === c.id} disabled={!!busy || locked || mine?.id === c.id || !wallet}
      onClick={() => void join(c)} data-testid={`guild-opt-${c.tag}`}>
      <GuildMark guild={c} size={24} />
      <span className="guild-opt-txt">
        <span className="guild-opt-tag">{c.tag}</span>
        <span className="guild-opt-sub">{c.name}{typeof c.members === "number" ? ` · ${C.members(c.members)}` : ""}</span>
      </span>
    </button>
  );

  return (
    <div className="pf-field guild-picker" role="group" aria-label={C.label} data-testid="guild-picker">
      <span className="pf-field-label">{C.label}</span>
      <div className="guild-current">
        {mine ? <GuildChip guild={mine} size="md" /> : <span className="pf-help">{C.none}</span>}
        <button type="button" className="ds-btn pf-btn-text" aria-expanded={open} disabled={!wallet} onClick={() => setOpen((o) => !o)}>{C.pick}</button>
        {mine && <button type="button" className="ds-btn pf-btn-text" disabled={!!busy || locked} onClick={() => void leave()}>{C.leave}</button>}
      </div>
      {!wallet && <span className="pf-help">{C.signIn}</span>}
      {locked && nextAt && <span className="pf-help">{C.wait(formatLocalWhen(nextAt))}</span>}
      {open && (
        <>
          <input className="pf-input" type="search" value={q} placeholder={C.search} aria-label={C.search} autoComplete="off" spellCheck={false}
            onChange={(e) => setQ(e.target.value)} />
          {GUILD_CATEGORIES.map((cat) => {
            const list = shown.filter((c) => c.category === cat.id);
            return list.length ? (
              <div key={cat.id} role="group" aria-label={cat.label}>
                <p className="guild-cat">{cat.label}</p>
                <div className="guild-grid">{list.map((c) => <Opt key={c.id} c={c} />)}</div>
              </div>
            ) : null;
          })}
          {(() => {
            const rest = shown.filter((c) => !c.category);
            if (found) rest.push(found);
            return rest.length ? (
              <div role="group" aria-label={C.playerGuilds}>
                <p className="guild-cat">{C.playerGuilds}</p>
                <div className="guild-grid">{rest.map((c) => <Opt key={c.id} c={c} />)}</div>
              </div>
            ) : null;
          })()}
          {!shown.length && !found && needle && <span className="pf-help">{C.noMatch}</span>}
          {!starting ? (
            <button type="button" className="ds-btn pf-btn-text" style={{ alignSelf: "flex-start" }} onClick={() => setStarting(true)}>{C.start}</button>
          ) : !hasUsername ? (
            <span className="pf-help">{C.needUsername}</span>
          ) : (
            <div className="guild-new">
              <input className="pf-input" value={tag} maxLength={GUILD_TAG_MAX} placeholder={C.tagLabel} aria-label={C.tagLabel} autoComplete="off" spellCheck={false}
                onChange={(e) => setTag(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
              <input className="pf-input" value={name} maxLength={GUILD_NAME_MAX * 4} placeholder={C.nameLabel} aria-label={C.nameLabel} autoComplete="off"
                onChange={(e) => setName(e.target.value)} />
              <button type="button" className="ds-btn pf-btn-primary" disabled={!!busy || tag.length < 2 || !name.trim() || locked} onClick={() => void start()}>{C.create}</button>
              <span className="pf-help" style={{ gridColumn: "1 / -1" }}>{C.tagHelp}</span>
            </div>
          )}
          <span className="pf-help">{C.starterNote}</span>
        </>
      )}
      {msg && <span className={msg.ok ? "pf-help" : "pf-bad"} role={msg.ok ? "status" : "alert"}>{msg.text}</span>}
      <span className="pf-help">{C.helper}</span>
    </div>
  );
}

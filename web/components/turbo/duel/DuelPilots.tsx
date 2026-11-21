"use client";
/**
 * Friends and rivals in the duel lobby's VS FRIEND tab (lib/duel/social). Rendered by DuelScreen into the engine's friend pane
 * through a portal, so the engine screens stay as they are. Each row: JOIN when they're waiting in an open room, else DUEL
 * (opens your room and sends them a duel request push). Rivals come from your finished online duels; + adds one as a friend.
 */
import { useCallback, useEffect, useState } from "react";
import { duelApi } from "@/lib/duel/client";
import type { PilotRow } from "@/lib/duel/social";

export interface PilotsHost { challenge(slug: string): void; join(code: string): void }

const CSS = `
.duel-root .dp{margin-top:14px}
.duel-root .dp-tabs{display:flex;gap:4px}
.duel-root .dp-tab{flex:1;height:34px;border:0;border-radius:10px;background:transparent;color:var(--muted);font:800 15px/1 var(--f-game);letter-spacing:.6px}
.duel-root .dp-tab.on{background:#23262F;color:var(--text)}
.duel-root .dp-tab i{font-style:normal;color:var(--green);margin-left:6px}
.duel-root .dp-list{list-style:none;margin:8px 0 0;padding:0;max-height:236px;overflow-y:auto;overscroll-behavior:contain}
.duel-root .dp-row{display:flex;align-items:center;gap:10px;min-height:52px;padding:4px 2px;border-bottom:1px solid rgba(255,255,255,.08)}
.duel-root .dp-av{position:relative;flex:none;width:34px;height:34px;border-radius:50%;border:2px solid #2E323A;background:#121327;display:grid;place-items:center;font:800 13px/1 var(--f-game);color:var(--text)}
.duel-root .dp-av.open{border-color:var(--green)}
.duel-root .dp-av.live{border-color:var(--gold)}
.duel-root .dp-nm{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.duel-root .dp-nm b{font:700 15px/1.15 var(--f-ui,system-ui,sans-serif);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.duel-root .dp-nm em{font-style:normal}
.duel-root .dp-nm span{display:flex;gap:6px;align-items:center;font:700 12px/1 var(--f-game);letter-spacing:.4px;color:var(--muted)}
.duel-root .dp-nm .nem{color:var(--pinkl)}
.duel-root .dp-nm .on{color:var(--green)}
.duel-root .dp-nm .lv{color:var(--gold)}
.duel-root .dp-btn{flex:none;height:36px;min-width:64px;padding:0 12px;border-radius:10px;border:2px solid var(--gold);background:transparent;color:var(--gold);font:800 15px/1 var(--f-game)}
.duel-root .dp-btn.go{background:var(--green);border-color:var(--green);color:#121327}
.duel-root .dp-btn:disabled{opacity:.45}
.duel-root .dp-ic{flex:none;width:32px;height:36px;border-radius:10px;border:0;background:transparent;color:var(--muted);font:800 18px/1 var(--f-game)}
.duel-root .dp-empty{margin:12px 2px 4px;font:700 14px/1.2 var(--f-game);letter-spacing:.4px;color:var(--muted)}
.duel-root .dp-add{display:flex;gap:6px;margin-top:8px}
.duel-root .dp-add input{flex:1;min-width:0;height:42px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:#0b0c18;color:var(--text);font:600 16px/1 var(--f-ui,system-ui,sans-serif);padding:0 12px}
.duel-root .dp-add button{height:42px;padding:0 16px;border-radius:12px;border:2px solid var(--gold);background:transparent;color:var(--gold);font:800 16px/1 var(--f-game)}
.duel-root .dp-err{margin:6px 2px 0;font:600 13px/1.3 var(--f-ui,system-ui,sans-serif);color:var(--pinkl)}
`;

const initials = (n: string) => n.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
const rec = (r: PilotRow) => (r.h2h ? `${r.h2h.w}-${r.h2h.l}${r.h2h.d ? `-${r.h2h.d}` : ""}` : null);

export default function DuelPilots({ host }: { host: PilotsHost }) {
  const [tab, setTab] = useState<"friends" | "rivals">("friends");
  const [data, setData] = useState<{ friends: PilotRow[]; rivals: PilotRow[] } | null>(null);
  const [err, setErr] = useState("");
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await duelApi.social();
    if (r.ok) setData({ friends: r.friends, rivals: r.rivals });
  }, []);
  useEffect(() => {
    void load();
    // refresh while the lobby is on screen, so JOIN shows up when a friend opens a room
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { if (data && !data.friends.length && data.rivals.length) setTab("rivals"); }, [data]);

  const friend = async (op: "add" | "remove", target: string) => {
    setBusy(true); setErr("");
    const r = await duelApi.friend(op, target);
    setBusy(false);
    if (!r.ok) { setErr(r.reason); return false; }
    await load(); return true;
  };
  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = who.trim(); if (!v || busy) return;
    if (await friend("add", v)) { setWho(""); setTab("friends"); }
  };
  const duel = (r: PilotRow) => {
    if (r.status === "open" && r.code) { host.join(r.code); return; }
    setSent(r.pid); host.challenge(r.slug);
  };

  const rows = (tab === "friends" ? data?.friends : data?.rivals) ?? [];
  const openN = (data?.friends ?? []).filter((f) => f.status === "open").length;
  return (
    <div className="dp" data-testid="duel-pilots">
      <style>{CSS}</style>
      <div className="dp-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "friends"} className={`dp-tab${tab === "friends" ? " on" : ""}`} onClick={() => setTab("friends")}>
          FRIENDS{openN ? <i>{openN}</i> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "rivals"} className={`dp-tab${tab === "rivals" ? " on" : ""}`} onClick={() => setTab("rivals")}>RIVALS</button>
      </div>
      {data && !rows.length && <p className="dp-empty">{tab === "friends" ? "No friends yet" : "No rivals yet"}</p>}
      {rows.length > 0 && (
        <ul className="dp-list">
          {rows.map((r) => {
            const h = rec(r);
            return (
              <li key={r.pid} className="dp-row" data-testid="duel-pilot-row">
                <span className={`dp-av${r.status ? ` ${r.status}` : ""}`} aria-hidden>{initials(r.name)}</span>
                <span className="dp-nm">
                  <b>{r.name}</b>
                  <span>
                    {r.status === "open" && <em className="on">IN A ROOM</em>}
                    {r.status === "live" && <em className="lv">DUELING</em>}
                    {h && <em>{h}</em>}
                    {r.nemesis && <em className="nem">NEMESIS</em>}
                  </span>
                </span>
                {tab === "rivals" && !r.friend && <button type="button" className="dp-ic" aria-label={`Add ${r.name} as a friend`} disabled={busy} onClick={() => void friend("add", r.pid)}>+</button>}
                {tab === "friends" && <button type="button" className="dp-ic" aria-label={`Remove ${r.name}`} disabled={busy} onClick={() => void friend("remove", r.pid)}>×</button>}
                <button type="button" className={`dp-btn${r.status === "open" ? " go" : ""}`} disabled={r.status === "live" || sent === r.pid} onClick={() => duel(r)}>
                  {r.status === "open" ? "JOIN" : sent === r.pid ? "SENT" : "DUEL"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {tab === "friends" && (
        <form className="dp-add" onSubmit={onAdd} autoComplete="off">
          <input value={who} onChange={(e) => setWho(e.target.value)} maxLength={42} placeholder="@username" aria-label="Add a friend by username" />
          <button type="submit" disabled={busy || !who.trim()}>ADD</button>
        </form>
      )}
      {err && <p className="dp-err" role="status">{err}</p>}
    </div>
  );
}

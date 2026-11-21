"use client";
/**
 * /admin/chat — Team review of chat reports (lib/server/chat/moderation): remove or restore a message, mute or unmute the
 * sender, dismiss. Same login gate as /admin/stats (Privy session whose email is in ADMIN_EMAILS, checked server side).
 */
import { useCallback, useEffect, useState } from "react";
import { onPrivy } from "@/lib/aa/session";
import { privyAccessToken } from "@/lib/aa/sessionState";
import { withBase } from "@/lib/base-path";
import { loginPrivy, NeedLogin } from "@/lib/invitesClient";
import type { ReportGroup } from "@/lib/server/chat/moderation";

type G = Omit<ReportGroup, "members">;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function call(method: "GET" | "POST", body?: unknown) {
  const t = await privyAccessToken();
  if (!t) throw new NeedLogin("Sign in first.");
  const r = await fetch(withBase("/api/admin/chat"), { method, headers: { authorization: `Bearer ${t}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error || "Something went wrong."), { status: r.status });
  return j as { groups?: G[] };
}

export default function AdminChat({ configured = false }: { configured?: boolean }) {
  const [rows, setRows] = useState<G[] | null>(null);
  const [gate, setGate] = useState<"login" | "denied" | "off" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!configured) { setGate("off"); return; }
    setErr(null);
    try { setRows((await call("GET")).groups ?? []); setGate(null); }
    catch (e) {
      const s = (e as { status?: number }).status;
      if (e instanceof NeedLogin || s === 401) setGate("login"); else if (s === 403) setGate("denied"); else if (s === 503) setGate("off"); else setErr((e as Error).message);
    }
  }, [configured]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); if (configured) return onPrivy(() => void load()); }, [configured]);

  const act = async (action: string, id: string) => {
    setBusy(id + action); setErr(null);
    try { await call("POST", { action, id }); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="cl-page as-page" data-testid="admin-chat">
      <header className="cl-head">
        <div><div className="cl-eyebrow">Team</div><h1 className="cl-display">Chat reports</h1></div>
        {rows && <button type="button" className="cl-btn sm" onClick={() => void load()}>Refresh</button>}
      </header>
      {gate === "login" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Log in</h3><button type="button" className="cl-btn primary" onClick={loginPrivy}>Log in</button></section>}
      {gate === "denied" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Team only</h3></section>}
      {gate === "off" && <section className="cl-card cl-empty"><h3 className="cl-display sm">No Team emails set</h3><p className="muted">Set ADMIN_EMAILS on the server.</p></section>}
      {err && <p className="cl-err" role="alert">{err}</p>}
      {!gate && rows && !rows.length && <section className="cl-card cl-empty"><h3 className="cl-display sm">No reports</h3></section>}
      {!gate && rows && rows.length > 0 && (
        <section className="cl-card as-card">
          <div className="as-scroll"><table className="as-table">
            <thead><tr><th>Message</th><th>From</th><th>Reports</th><th>Last</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((g) => (
              <tr key={g.id} data-testid="report-row">
                <td style={{ maxWidth: 360, whiteSpace: "normal" }}>{g.text}<div className="muted"><a href={withBase(`/coin/${g.coin}`)} target="_blank" rel="noreferrer">coin {short(g.coin)}</a> · {when(g.sentAt)}</div></td>
                <td>{g.from ? (g.from.name ? `@${g.from.name}` : short(g.from.addr)) : "?"}</td>
                <td>{g.reporters} · {g.reasons.join(", ")}</td>
                <td>{when(g.lastAt)}</td>
                <td>{g.hidden ? "Removed" : "Visible"}{g.muted ? " · Muted" : ""}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button type="button" className="cl-btn sm" disabled={!!busy} onClick={() => void act(g.hidden ? "restore" : "remove", g.id)}>{g.hidden ? "Restore" : "Remove"}</button>{" "}
                  {g.from && <button type="button" className="cl-btn sm" disabled={!!busy} onClick={() => void act(g.muted ? "unmute" : "mute", g.id)}>{g.muted ? "Unmute" : "Mute"}</button>}{" "}
                  <button type="button" className="cl-btn sm" disabled={!!busy} onClick={() => void act("dismiss", g.id)}>Dismiss</button>
                </td>
              </tr>))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}

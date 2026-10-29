"use client";
/**
 * /admin/invites — the invite-only switch, admin codes, the waitlist and the action log. Auth = Privy login (email or
 * Google) checked server-side against ADMIN_EMAILS; no wallet involved. Every action uses a fresh single-use nonce.
 * `configured` comes from the server page: false ⇒ "No admins configured", nothing else is requested (fail closed).
 */
import { useCallback, useEffect, useState } from "react";
import { onPrivy } from "@/lib/aa/session";
import { adminInviteDo, adminInvites, inviteLink, loginPrivy, NeedLogin, type AdminData } from "@/lib/invitesClient";

const when = (t: number) => new Date(t).toLocaleString();

export default function AdminInvites({ configured = false }: { configured?: boolean }) {
  const [data, setData] = useState<AdminData | null>(null);
  const [gate, setGate] = useState<"login" | "denied" | "off" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState("5");
  const [pid, setPid] = useState("");
  const [topN, setTopN] = useState("3");

  const load = useCallback(async () => {
    if (!configured) { setGate("off"); return; }
    setErr(null);
    try { setData(await adminInvites()); setGate(null); }
    catch (e) {
      const s = (e as { status?: number }).status;
      setData(null);
      if (e instanceof NeedLogin || s === 401) setGate("login");
      else if (s === 403) setGate("denied");
      else if (s === 503) setGate("off");
      else setErr((e as Error).message);
    }
  }, [configured]);
  useEffect(() => { void load(); if (configured) return onPrivy(() => void load()); }, [load, configured]);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await adminInviteDo(body); setMsg(r.codes ? `${done}: ${r.codes.join(", ")}` : done); await load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="cl-page cl-form" data-testid="admin-invites">
      <header className="cl-head"><div>
        <div className="cl-eyebrow">Admin</div><h1 className="cl-display">Invites</h1>
        <p className="muted">{data?.me ? `Signed in as ${data.me}` : gate === "off" ? "Invite admin is closed." : "Email or Google login. Access is limited to the admin list."}</p>
      </div></header>

      {gate === "login" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Log in to manage invites</h3><button type="button" className="cl-btn primary" onClick={loginPrivy}>Log in</button></section>}
      {gate === "denied" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Not an admin</h3><p className="muted">This login isn&apos;t on the admin list.</p></section>}
      {gate === "off" && <section className="cl-card cl-empty" data-testid="admin-off"><h3 className="cl-display sm">No admins configured</h3><p className="muted">Set ADMIN_EMAILS on the server to enable this page. Access stays closed until then.</p></section>}
      {err && <p className="cl-err" role="alert">{err}</p>}
      {msg && <p className="cl-ok" role="status">{msg}</p>}

      {!gate && data && (
        <div style={{ display: "grid", gap: 16 }}>
          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Invite-only is {data.mode ? "ON" : "OFF"}</h3>
            <p className="muted cl-fine">{data.modeSource === "kv" ? "Set on this page." : `Using the server default (${data.envDefault ? "on" : "off"}).`} When it&apos;s off, everyone can play.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" className="cl-btn sm" disabled={busy || (data.mode && data.modeSource === "kv")} onClick={() => void act({ action: "mode", mode: "on" }, "Invite-only is on")}>Turn on</button>
              <button type="button" className="cl-btn sm" disabled={busy || (!data.mode && data.modeSource === "kv")} onClick={() => void act({ action: "mode", mode: "off" }, "Invite-only is off")}>Turn off</button>
              <button type="button" className="cl-btn sm ghost" disabled={busy || data.modeSource !== "kv"} onClick={() => void act({ action: "mode", mode: "default" }, "Back to the server default")}>Use server default</button>
            </div>
          </section>

          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Make codes</h3>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input aria-label="How many" value={n} onChange={(e) => setN(e.target.value)} style={{ width: 70, padding: "8px 10px" }} inputMode="numeric" />
              <button type="button" className="cl-btn sm primary" disabled={busy} onClick={() => void act({ action: "create", n: Number(n) }, "Made")}>Make codes</button>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: "14px 0 0", display: "grid", gap: 6 }}>
              {data.codes.slice(0, 200).map((c) => (
                <li key={c.code} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="cl-mono" style={{ letterSpacing: ".1em" }}>{c.code}</span>
                  <span className="muted cl-fine" style={{ margin: 0 }}>{c.revoked ? "revoked" : c.usedBy ? `used ${c.usedAt ? when(c.usedAt) : ""} by ${c.usedBy}` : "unused"}</span>
                  {!c.usedBy && !c.revoked && <>
                    <button type="button" className="cl-btn sm ghost" onClick={() => void navigator.clipboard.writeText(inviteLink(c.code)).catch(() => undefined)}>Copy link</button>
                    <button type="button" className="cl-btn sm danger" disabled={busy} onClick={() => void act({ action: "revoke", code: c.code }, `Revoked ${c.code}`)}>Revoke</button>
                  </>}
                </li>
              ))}
            </ul>
          </section>

          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Let someone in, or add invites</h3>
            <p className="muted cl-fine">Player id looks like did:privy:… (from the waitlist below).</p>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <input aria-label="Player id" placeholder="did:privy:…" value={pid} onChange={(e) => setPid(e.target.value.trim())} style={{ minWidth: 280, padding: "8px 10px" }} />
              <button type="button" className="cl-btn sm primary" disabled={busy || !pid} onClick={() => void act({ action: "admit", privyId: pid }, "Let in")}>Let in</button>
              <input aria-label="Invites to add" value={topN} onChange={(e) => setTopN(e.target.value)} style={{ width: 60, padding: "8px 10px" }} inputMode="numeric" />
              <button type="button" className="cl-btn sm" disabled={busy || !pid} onClick={() => void act({ action: "topup", privyId: pid, n: Number(topN) }, "Invites added")}>Add invites</button>
            </div>
          </section>

          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Waitlist ({data.waitlist.length})</h3>
            {!data.waitlist.length ? <p className="muted cl-fine">Nobody yet.</p> : (
              <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 6 }}>
                {data.waitlist.map((w) => (
                  <li key={w.privyId} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span className="cl-mono">{w.privyId}</span><span className="muted cl-fine" style={{ margin: 0 }}>{when(w.at)}</span>
                    <button type="button" className="cl-btn sm" disabled={busy} onClick={() => void act({ action: "admit", privyId: w.privyId }, "Let in")}>Let in</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="cl-card" style={{ padding: 22 }}>
            <h3 className="cl-display xs">Recent activity</h3>
            <ul className="cl-mono" style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 4 }}>
              {data.log.map((l, i) => <li key={i}>{when(Number(l.t))} · {String(l.a)} {["code", "who", "n", "mode", "by"].filter((k) => l[k] != null).map((k) => `${k}=${String(l[k])}`).join(" ")}</li>)}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

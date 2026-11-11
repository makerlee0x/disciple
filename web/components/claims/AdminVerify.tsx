"use client";
/**
 * /admin/verifications — review verification requests. Auth = Privy login (email/Google) checked server-side against
 * ADMIN_EMAILS (case-insensitive); no wallet involved. Every action uses a fresh single-use nonce.
 * `configured` comes from the server page: false ⇒ "No admins configured", nothing else is requested (fail closed).
 */
import { useCallback, useEffect, useState } from "react";
import { adminDo, adminRows, loginPrivy, NeedLogin, type AdminRow } from "@/lib/claims/verifyClient";
import { onPrivy } from "@/lib/aa/session";
import { plainText } from "@/lib/aa/relayOp";
import { invalidateVerified } from "@/lib/verifiedClient";
import { demoEnabled } from "@/lib/claims/demo";
import { SampleTag, shortA } from "./ui";

const TABS = ["pending", "approved", "rejected", "revoked"] as const;
type Tab = (typeof TABS)[number];

const DEMO: AdminRow[] = [
  { token: "0xcac8a9654de3ae01470fc9e93e58fb97d5b86bb3", creator: "0x5a3c7743d365f770710fe15f4bbf1cec7bc41006", x: "smoke_rocket", website: "https://disciple.vip/", note: "Team rocket for the RH testnet smoke run.", status: "pending", requestedAt: Date.now() - 3_600_000, updatedAt: Date.now() - 3_600_000 },
  { token: "0x000000000000000000000000000000000000d302", creator: "0x7777777777777777777777777777777777777777", x: "halodrive", website: null, note: "", status: "pending", requestedAt: Date.now() - 7_200_000, updatedAt: Date.now() - 7_200_000 },
  { token: "0x000000000000000000000000000000000000d303", creator: "0x7777777777777777777777777777777777777778", x: null, website: "https://quiet-orbit.xyz/", note: "Art project.", status: "approved", requestedAt: Date.now() - 86_400_000, updatedAt: Date.now() - 80_000_000, reviewedBy: "maker@…" },
];

export default function AdminVerify({ configured = false }: { configured?: boolean }) {
  const demo = typeof window !== "undefined" && demoEnabled();
  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [gate, setGate] = useState<"login" | "denied" | "off" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (demo) { setMe("maker@example.com"); setRows(DEMO.filter((r) => r.status === tab)); setGate(null); return; }
    if (!configured) { setRows(null); setGate("off"); return; }
    setErr(null);
    try { const r = await adminRows(tab); setRows(r.rows); setMe(r.me); setGate(null); }
    catch (e) {
      const s = (e as { status?: number }).status;
      setRows(null);
      if (e instanceof NeedLogin || s === 401) setGate("login");
      else if (s === 403) setGate("denied");
      else if (s === 503) setGate("off");
      else setErr(plainText((e as Error).message, "admin verify"));
    }
  }, [tab, demo, configured]);
  useEffect(() => { void load(); if (!demo && configured) return onPrivy(() => void load()); }, [load, demo, configured]);

  const act = async (r: AdminRow, action: "approve" | "reject" | "revoke") => {
    setBusy(r.token + action); setErr(null);
    try {
      if (demo) { await new Promise((x) => setTimeout(x, 300)); }
      else { await adminDo(r.token, action, reason[r.token] || undefined); invalidateVerified(r.token); }
      setRows((xs) => (xs ?? []).filter((x) => x.token !== r.token));
    } catch (e) { setErr(plainText((e as Error).message, "admin verify")); } finally { setBusy(null); }
  };

  return (
    <div className="cl-page" data-testid="admin-verify">
      <header className="cl-head">
        <div>
          <div className="cl-eyebrow">Admin</div>
          <h1 className="cl-display">Verification review</h1>
          <p className="muted">{me ? `Signed in as ${me}` : gate === "off" ? "Review is closed." : "Email or Google login. Access is limited to the admin list."}</p>
        </div>
        <SampleTag show={demo} />
      </header>

      {gate === "login" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Log in to review</h3><button type="button" className="cl-btn primary" onClick={loginPrivy}>Log in</button></section>}
      {gate === "denied" && <section className="cl-card cl-empty"><h3 className="cl-display sm">Not an admin</h3><p className="muted">This login isn&apos;t on the admin list.</p></section>}
      {gate === "off" && <section className="cl-card cl-empty" data-testid="admin-off"><h3 className="cl-display sm">No admins configured</h3><p className="muted">Set ADMIN_EMAILS on the server to enable review. Access stays closed until then.</p></section>}

      {!gate && (
        <>
          <nav className="cl-tabs" role="tablist">
            {TABS.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
          </nav>
          {err && <p className="cl-err" role="alert">{err}</p>}
          {rows == null ? <section className="cl-card cl-empty"><div className="cl-skel" /></section> : !rows.length ? (
            <section className="cl-card cl-empty"><p className="muted">Nothing here.</p></section>
          ) : (
            <div className="cl-table" role="table">
              {rows.map((r) => (
                <div key={r.token} className="cl-card cl-review" role="row" data-testid="admin-row">
                  <div className="cl-review-main">
                    <a className="cl-rocket-name" href={`/coin/${r.token}`} target="_blank" rel="noreferrer">{shortA(r.token)}</a>
                    <div className="muted cl-mono">creator {shortA(r.creator)} · {new Date(r.requestedAt).toLocaleString()}</div>
                    <div className="cl-links">
                      {r.x && <a href={`https://x.com/${r.x}`} target="_blank" rel="noreferrer noopener nofollow">@{r.x}</a>}
                      {r.website && <a href={r.website} target="_blank" rel="noreferrer noopener nofollow">{r.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>}
                    </div>
                    {r.note && <p className="cl-quote">{r.note}</p>}
                    {r.reviewedBy && <p className="muted cl-fine">{r.status} by {r.reviewedBy}{r.reason ? ` · ${r.reason}` : ""}</p>}
                  </div>
                  <div className="cl-review-act">
                    {r.status !== "approved" && <input className="cl-reason" placeholder="Reason (optional)" maxLength={280} value={reason[r.token] ?? ""} onChange={(e) => setReason({ ...reason, [r.token]: e.target.value })} />}
                    <div className="cl-actions">
                      {r.status === "approved" ? (
                        <button type="button" className="cl-btn danger" disabled={!!busy} onClick={() => act(r, "revoke")}>Revoke</button>
                      ) : (
                        <>
                          {r.status === "pending" && <button type="button" className="cl-btn ghost" disabled={!!busy} onClick={() => act(r, "reject")}>Reject</button>}
                          <button type="button" className="cl-btn primary" disabled={!!busy} onClick={() => act(r, "approve")}>Approve</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

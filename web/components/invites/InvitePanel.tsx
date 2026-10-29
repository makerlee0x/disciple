"use client";
/**
 * /invite — redeem a code, join the waitlist, or (once in) see your invites. /i/<CODE> lands here with ?code=.
 * With invite-only off it just says no invite is needed.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { INVITE_COPY as C, inviteErrorText } from "@/lib/copy/invites";
import { clearPendingCode, joinWaitlist, loginPrivy, pendingCode, redeemInvite, savePendingCode } from "@/lib/invitesClient";
import { useInvites } from "./useInvites";
import MyInvites from "./MyInvites";

export default function InvitePanel() {
  const { st, reload } = useInvites();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("code");
    if (q) savePendingCode(q);
    setCode(q || pendingCode());
  }, []);

  const redeem = async () => {
    setBusy(true); setErr(null);
    try { await redeemInvite(code.trim()); clearPendingCode(); await reload(); }
    catch (e) { setErr(inviteErrorText((e as { code?: string }).code)); }
    finally { setBusy(false); }
  };
  const waitlist = async () => {
    setBusy(true); setErr(null);
    try { await joinWaitlist(); await reload(); } catch { setErr(C["error.generic"]); } finally { setBusy(false); }
  };

  return (
    <div className="cl-page" data-testid="invite-page" style={{ maxWidth: 640 }}>
      <header className="cl-head"><div><div className="cl-eyebrow">Invites</div><h1 className="cl-display">{st?.in ? C["in.title"] : st && !st.mode ? C["off.title"] : C["gate.title"]}</h1></div></header>
      {!st ? <section className="cl-card cl-empty"><div className="cl-skel" /></section>
        : st.in ? <section className="cl-card" style={{ padding: 28 }}><MyInvites codes={st.codes ?? []} /></section>
        : !st.mode ? (
          <section className="cl-card cl-empty"><p className="muted">{C["off.body"]}</p><Link className="cl-btn primary" href="/">{C["off.home"]}</Link></section>
        ) : !st.signedIn ? (
          <section className="cl-card cl-empty">
            <h3 className="cl-display sm">{C["signin.title"]}</h3><p className="muted">{C["signin.body"]}</p>
            <button type="button" className="cl-btn primary" onClick={loginPrivy}>{C["signin.button"]}</button>
          </section>
        ) : (
          <section className="cl-card cl-empty cl-form">
            <p className="muted">{C["gate.body"]}</p>
            <form style={{ display: "flex", gap: 10, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void redeem(); }}>
              <input aria-label={C["redeem.label"]} placeholder={C["redeem.placeholder"]} value={code} maxLength={12} autoCapitalize="characters" autoComplete="off" spellCheck={false}
                onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: ".12em", padding: "10px 12px", minWidth: 180 }} />
              <button type="submit" className="cl-btn primary" disabled={busy || code.trim().length < 8}>{C["redeem.button"]}</button>
            </form>
            {err && <p className="cl-err" role="alert">{err}</p>}
            {st.waitlisted ? <p className="cl-ok" role="status">{C["waitlist.done"]}</p>
              : <button type="button" className="cl-btn ghost" disabled={busy} onClick={() => void waitlist()}>{C["waitlist.button"]}</button>}
          </section>
        )}
    </div>
  );
}

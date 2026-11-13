"use client";
/**
 * /invite (step 7 board "/invite", maker 2026-11-13): one card on the lobby sky. /i/<CODE> lands here with ?code=,
 * which is saved and filled in. States: signed out (seat saved, sign in), signed in (enter a code, or join the
 * waitlist), waitlisted, in (your invites), and invite-only off (no invite needed). A saved code is used for the
 * player right after they sign in.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { INVITE_COPY as C, inviteErrorText } from "@/lib/copy/invites";
import { clearPendingCode, joinWaitlist, loginPrivy, pendingCode, redeemInvite, savePendingCode } from "@/lib/invitesClient";
import { withBase } from "@/lib/base-path";
import { useInvites } from "./useInvites";
import MyInvites from "./MyInvites";

export default function InvitePanel() {
  const { st, reload } = useInvites();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auto = useRef(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("code");
    if (q) savePendingCode(q);
    setCode((q || pendingCode()).toUpperCase());
  }, []);

  const redeem = async (c = code) => {
    setBusy(true); setErr(null);
    try { await redeemInvite(c.trim()); clearPendingCode(); await reload(); }
    catch (e) { setErr(inviteErrorText((e as { code?: string }).code)); }
    finally { setBusy(false); }
  };
  const waitlist = async () => {
    setBusy(true); setErr(null);
    try { await joinWaitlist(); await reload(); } catch { setErr(C["error.generic"]); } finally { setBusy(false); }
  };

  // "Sign in and we'll use this code for you": once signed in with a saved code, use it once.
  useEffect(() => {
    if (auto.current || !st?.mode || !st.signedIn || st.in) return;
    const saved = pendingCode().trim();
    if (saved.length < 8) return;
    auto.current = true;
    void redeem(saved.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const codeForm = (gold: boolean) => (
    <form className="iv-form" onSubmit={(e) => { e.preventDefault(); void redeem(); }}>
      <input className="iv-in" aria-label={C["redeem.label"]} placeholder={C["redeem.placeholder"]} value={code} maxLength={12} autoCapitalize="characters" autoComplete="off" spellCheck={false}
        onChange={(e) => setCode(e.target.value.toUpperCase())} />
      <button type="submit" className={gold ? "r2-gold iv-use" : "r2-btn iv-use"} disabled={busy || code.trim().length < 8}>{C["redeem.button"]}</button>
    </form>
  );
  const errNote = err && <p className="r2-note iv-pink" role="alert"><span aria-hidden>!</span><span>{err}</span></p>;

  let body: React.ReactNode;
  if (!st) body = <div className="iv-card"><div className="iv-skel" /></div>;
  else if (!st.mode) body = (
    <div className="iv-card" data-state="off">
      <span className="r2-eb iv-green">{C["off.eyebrow"]}</span>
      <h1 className="r2-g">{C["off.title"]}</h1>
      <p>{C["off.body"]}</p>
      <Link className="r2-gold" href="/">{C["off.home"]}</Link>
    </div>
  );
  else if (st.in) body = <div className="iv-card iv-wide" data-state="in"><MyInvites codes={st.codes ?? []} /></div>;
  else if (!st.signedIn) {
    const has = code.trim().length >= 8;
    body = (
      <div className="iv-card" data-state="signin">
        <span className={`r2-eb${has ? " iv-gold" : ""}`}>{has ? C["signin.eyebrow"] : C["gate.eyebrow"]}</span>
        <h1 className="r2-g">{has ? C["signin.title"] : C["signin.nocode.title"]}</h1>
        <p>{has ? C["signin.body"] : C["signin.nocode.body"]}</p>
        {has && <div className="iv-in iv-show" aria-label={C["redeem.label"]}>{code}</div>}
        <button type="button" className="r2-gold" onClick={loginPrivy}>{has ? C["signin.button"] : C["signin.nocode.button"]}</button>
        <span className="iv-fine">{C["signin.fine"]}</span>
      </div>
    );
  } else if (st.waitlisted) body = (
    <div className="iv-card" data-state="waitlisted">
      <span className="r2-eb">{C["waitlist.eyebrow"]}</span>
      <h1 className="r2-g">{C["waitlist.title"]}</h1>
      <p className="r2-note iv-ok" role="status"><span aria-hidden>✓</span><span>{C["waitlist.done"]}</span></p>
      {codeForm(false)}
      {errNote}
      <span className="iv-fine iv-left">{C["waitlist.watchLine"]}</span>
      <Link className="r2-btn iv-wbtn" href="/play" prefetch={false}>{C["waitlist.watch"]}</Link>
    </div>
  );
  else body = (
    <div className="iv-card" data-state="gate">
      <span className="r2-eb">{C["gate.eyebrow"]}</span>
      <h1 className="r2-g">{C["gate.title"]}</h1>
      <p>{C["gate.body"]}</p>
      {codeForm(true)}
      {errNote}
      <button type="button" className="r2-btn iv-wbtn" disabled={busy} onClick={() => void waitlist()}>{C["waitlist.button"]}</button>
    </div>
  );

  return (
    <section className="ls-page iv-page" data-testid="invite-page">
      <div className="ls-sky" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/home/sky/t6.webp")} alt="" />
      </div>
      {body}
    </section>
  );
}

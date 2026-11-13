"use client";
/**
 * Verification for one rocket (Privy session; stored for admin review at /admin/verifications). Round 2 board: a row at
 * the bottom of the Host earnings bay card ("Not verified yet" + Get verified, or the blue Verified check) and the
 * "Get verified" popup with stacked fields, instead of the old inline form.
 */
import { useEffect, useState } from "react";
import Sheet from "@/components/profile/Sheet";
import { NeedLogin, loginPrivy, myVerification, requestVerification, type MyRequest } from "@/lib/claims/verifyClient";
import { onPrivy } from "@/lib/aa/session";
import { plainText } from "@/lib/aa/relayOp";
import { CashHead, ErrIcon } from "@/components/cash/bits";

export const VERIFY_COPY = {
  not: "Not verified yet",
  review: "In review",
  verified: "Verified",
  rejected: "Not approved",
  revoked: "Check removed",
  open: "Get verified",
  signIn: "Sign in to get verified",
  title: "Get verified",
  body: (name: string) => `The team checks who's behind ${name}. Verified rockets get the blue check everywhere.`,
  x: "X account", web: "Website", note: "Anything else (optional)", notePh: "Who's behind it?",
  send: "Send for review", sending: "Sending…",
  fine: "No signing needed. We'll show the check once it's approved.",
  sent: "Sent for review. We'll show the check once it's approved.",
} as const;

export function Seal({ on }: { on?: boolean }) {
  const p = "M12 3l2.4 1.8 3-.2.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.2L12 21l-2.4-1.8-3 .2-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .2z";
  return on
    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="#A9C4FF" stroke="#121327" strokeWidth="1.5" aria-hidden><path d={p} /><path d="M8.5 12l2.5 2.5 4.5-5" strokeWidth="2" /></svg>
    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A9C4FF" strokeWidth="2" aria-hidden><path d={p} /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>;
}

export default function VerifyRequest({ token, name, demo }: { token: string; name?: string; demo?: boolean }) {
  const [mine, setMine] = useState<MyRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ x: "", website: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    if (demo) { setMine({ status: null }); return; }
    const run = () => myVerification(token).then((m) => { setMine(m); setNeedLogin(false); }).catch((e) => { if (e instanceof NeedLogin) setNeedLogin(true); setMine({ status: null }); });
    void run();
    return onPrivy(() => void run());
  }, [token, demo]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 400)); setMine({ status: "pending" }); setOpen(false); return; }
      await requestVerification({ token, ...f });
      setMine({ status: "pending", ...f }); setOpen(false);
    } catch (e) {
      if (e instanceof NeedLogin) { setNeedLogin(true); loginPrivy(); }
      setErr(plainText((e as Error).message, "verify request"));
    } finally { setBusy(false); }
  };

  const st = mine?.status;
  const canAsk = !st || st === "rejected" || st === "revoked";
  const label = st === "approved" ? VERIFY_COPY.verified : st === "pending" ? VERIFY_COPY.review : st === "rejected" ? VERIFY_COPY.rejected : st === "revoked" ? VERIFY_COPY.revoked : VERIFY_COPY.not;
  return (
    <div className="he-verify" data-testid="verify-request">
      <span className={`he-vstate${st === "approved" ? " on" : ""}`}><Seal on={st === "approved"} />{label}</span>
      {canAsk && (
        <button type="button" className="r2-btn" onClick={() => (needLogin && !demo ? loginPrivy() : (setErr(null), setOpen(true)))} data-testid="verify-open">
          {needLogin && !demo ? VERIFY_COPY.signIn : VERIFY_COPY.open}
        </button>
      )}
      {st === "rejected" && mine?.reason ? <p className="he-vreason">{mine.reason}</p> : null}
      <Sheet open={open} onClose={() => setOpen(false)} label={VERIFY_COPY.title} className="r2-modal" testId="verify-popup">
        <CashHead title={VERIFY_COPY.title} onClose={() => setOpen(false)} />
        <form className="r2-body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <span className="he-vbody">{VERIFY_COPY.body(name || "this rocket")}</span>
          <div><label className="r2-lbl" htmlFor={`vx-${token}`}>{VERIFY_COPY.x}</label><input id={`vx-${token}`} className="r2-field he-in" value={f.x} maxLength={40} placeholder="@yourrocket" onChange={(e) => setF({ ...f, x: e.target.value })} /></div>
          <div><label className="r2-lbl" htmlFor={`vw-${token}`}>{VERIFY_COPY.web}</label><input id={`vw-${token}`} className="r2-field he-in" value={f.website} maxLength={200} placeholder="https://" onChange={(e) => setF({ ...f, website: e.target.value })} /></div>
          <div><label className="r2-lbl" htmlFor={`vn-${token}`}>{VERIFY_COPY.note}</label><textarea id={`vn-${token}`} className="r2-field he-in he-ta" value={f.note} maxLength={280} placeholder={VERIFY_COPY.notePh} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          {err && <div className="r2-note err" role="alert"><ErrIcon /><span>{err}</span></div>}
          <button type="submit" className="r2-gold" disabled={busy || (!f.x.trim() && !f.website.trim())} data-testid="verify-submit">{busy ? VERIFY_COPY.sending : VERIFY_COPY.send}</button>
          <span className="cx-fine">{VERIFY_COPY.fine}</span>
        </form>
      </Sheet>
    </div>
  );
}

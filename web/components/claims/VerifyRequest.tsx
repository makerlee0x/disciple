"use client";
/** Request verification for one rocket (Privy session; stored for admin review at /admin/verifications). */
import { useEffect, useState } from "react";
import { NeedLogin, loginPrivy, myVerification, requestVerification, type MyRequest } from "@/lib/claims/verifyClient";
import { onPrivy } from "@/lib/aa/session";
import { plainText } from "@/lib/aa/relayOp";

const LABEL: Record<string, string> = { pending: "In review", approved: "Verified", rejected: "Not approved", revoked: "Revoked" };

export default function VerifyRequest({ token, demo }: { token: string; demo?: boolean }) {
  const [mine, setMine] = useState<MyRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ x: "", website: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    if (demo) { setMine({ status: null }); return; }
    const run = () => myVerification(token).then((m) => { setMine(m); setNeedLogin(false); }).catch((e) => { if (e instanceof NeedLogin) setNeedLogin(true); setMine({ status: null }); });
    void run();
    return onPrivy(() => void run());
  }, [token, demo]);

  useEffect(() => { if (demo && typeof window !== "undefined" && new URLSearchParams(location.search).get("verify") === token.toLowerCase()) { setOpen(true); setF({ x: "smoke_rocket", website: "disciple.vip", note: "Team rocket for the RH testnet smoke run." }); } }, [demo, token]);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 400)); setMine({ status: "pending" }); setOpen(false); setMsg({ ok: true, t: "Sent. We review requests by hand." }); return; }
      await requestVerification({ token, ...f });
      setMine({ status: "pending", ...f }); setOpen(false); setMsg({ ok: true, t: "Sent. We review requests by hand." });
    } catch (e) {
      if (e instanceof NeedLogin) { setNeedLogin(true); loginPrivy(); }
      setMsg({ ok: false, t: plainText((e as Error).message, "verify request") });
    } finally { setBusy(false); }
  };

  const st = mine?.status;
  return (
    <div className="cl-verify" data-testid="verify-request">
      <div className="cl-verify-row">
        <span className="cl-eyebrow">Verification</span>
        {st ? <span className={`cl-pill ${st}`}>{LABEL[st]}</span> : null}
        {(!st || st === "rejected" || st === "revoked") && !open && (
          <button type="button" className="cl-btn ghost sm" onClick={() => (needLogin && !demo ? loginPrivy() : setOpen(true))} data-testid="verify-open">
            {needLogin && !demo ? "Log in to request" : "Request verification"}
          </button>
        )}
      </div>
      {st === "rejected" && mine?.reason ? <p className="muted cl-fine">{mine.reason}</p> : null}
      {open && (
        <form className="cl-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label><span>X handle</span><input value={f.x} maxLength={40} placeholder="@yourrocket" onChange={(e) => setF({ ...f, x: e.target.value })} /></label>
          <label><span>Website</span><input value={f.website} maxLength={200} placeholder="https://" onChange={(e) => setF({ ...f, website: e.target.value })} /></label>
          <label className="wide"><span>Short note</span><textarea value={f.note} maxLength={280} rows={2} placeholder="Who's behind it? (optional)" onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="cl-actions">
            <button type="button" className="cl-btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="cl-btn primary sm" disabled={busy || (!f.x.trim() && !f.website.trim())} data-testid="verify-submit">{busy ? "Sending…" : "Send request"}</button>
          </div>
          <p className="cl-fine muted">Uses your login. No wallet signature. An admin checks the links before the badge shows.</p>
        </form>
      )}
      {msg && <p className={msg.ok ? "cl-ok" : "cl-err"} role="status">{msg.t}</p>}
    </div>
  );
}

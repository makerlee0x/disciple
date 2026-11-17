"use client";

/**
 * Link / unlink an X account (OAuth via /api/x, lib/xLink.ts). Used by Edit profile and Settings.
 * Shows the verified handle when linked, a Connect X button when not, and nothing at all when the server has no X app
 * configured (so there's never a dead button). Reads the ?x= result the OAuth callback adds, shows it once, then drops it.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchXLink, startXLink, unlinkX, X_CHANGED_EVENT, X_NOTE_EVENT } from "@/lib/xLinkClient";
import { isXResult, X_RESULT_COPY, X_RESULT_PARAM, type XLinkStatus } from "@/lib/xLink";

export default function XLinkControl({ wallet, btnClass = "ds-btn", render, beforeConnect }: {
  wallet: string | null;
  /** Runs before the page goes to X (Edit profile saves unsaved edits so a new picture / bio isn't lost). false = stop. */
  beforeConnect?: () => Promise<boolean>;
  btnClass?: string;
  /** Layout hook: the caller places the handle / button / note. */
  render: (p: { handle: string | null; action: React.ReactNode; note: string }) => React.ReactNode;
}) {
  const [st, setSt] = useState<XLinkStatus>({ enabled: false, link: null });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => { fetchXLink(wallet).then(setSt).catch(() => {}); }, [wallet]);
  useEffect(() => { load(); addEventListener(X_CHANGED_EVENT, load); return () => removeEventListener(X_CHANGED_EVENT, load); }, [load]);

  // iPhone app: the X link finished after the sign-in sheet (lib/xLinkClient finishPendingXLink)
  useEffect(() => {
    const on = (e: Event) => setNote(String((e as CustomEvent<string>).detail || ""));
    addEventListener(X_NOTE_EVENT, on);
    return () => removeEventListener(X_NOTE_EVENT, on);
  }, []);

  // The OAuth callback lands back here with ?x=<result>: say it once, then clean the URL.
  useEffect(() => {
    const u = new URL(location.href);
    const r = u.searchParams.get(X_RESULT_PARAM);
    if (!isXResult(r)) return;
    setNote(X_RESULT_COPY[r]);
    u.searchParams.delete(X_RESULT_PARAM);
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }, []);

  if (!wallet || (!st.enabled && !st.link)) return null;

  const action = st.link ? (
    <button type="button" className={btnClass} disabled={busy} data-testid="x-unlink"
      onClick={async () => { setBusy(true); setNote(""); const r = await unlinkX(wallet); setBusy(false); if (!r.ok) setNote(r.reason || "Couldn't unlink X."); else setNote(""); }}>
      {busy ? "Unlinking…" : "Unlink"}
    </button>
  ) : (
    <button type="button" className={btnClass} disabled={busy} data-testid="connect-x"
      onClick={async () => {
        setBusy(true); setNote("");
        if (beforeConnect && !(await beforeConnect())) { setBusy(false); return; }
        const r = await startXLink(wallet); setBusy(false); setNote(r.reason);
      }}>
      {busy ? "Opening X…" : "Connect X"}
    </button>
  );
  return <>{render({ handle: st.link?.username ?? null, action, note })}</>;
}

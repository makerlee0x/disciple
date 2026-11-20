"use client";
/**
 * The Cash → Turbo transfer after its popup is closed (maker 2026-11-20): a small chip with a spinner and the est.
 * countdown while it lands, then a toast when it's in (or when it failed). Reads lib/turbo/landing. Tap the chip to
 * open the Turbo popup again.
 */
import { useEffect, useState } from "react";
import { clearLanding, onLanding, type Landing } from "@/lib/turbo/landing";
import { openTurbo } from "@/lib/turbo/turboPill";

const TEXT = {
  landing: "Landing in Turbo",
  setup: "Setting up Turbo",
  done: (v: string) => `${v} landed in Turbo cash.`,
  doneTitle: "Turbo cash is in",
  failTitle: "Turbo transfer stopped",
  view: "View",
  close: "Close",
  over: "any sec",
};
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export default function TurboLanding() {
  const [l, setL] = useState<Landing>({ step: null });
  const [now, setNow] = useState(() => Date.now());
  const [shut, setShut] = useState(0);   // endedAt of the result the player closed
  useEffect(() => onLanding(setL), []);
  const busy = !!l.step && l.step !== "done";
  useEffect(() => { if (!busy) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, [busy]);
  const ended = !busy && l.endedAt != null && l.endedAt !== shut && (l.step === "done" || !!l.error);
  useEffect(() => { if (!ended) return; const t = setTimeout(() => setShut(l.endedAt!), 12_000); return () => clearTimeout(t); }, [ended, l.endedAt]);

  if (busy) {
    const left = l.landsAt != null && l.step === "arriving" ? Math.ceil((l.landsAt - now) / 1000) : null;
    return (
      <button type="button" className="tl-chip" onClick={() => openTurbo("add")} data-testid="turbo-landing-chip" aria-live="polite">
        <span className="am-spin tl-spin" aria-hidden />
        <span>{l.step === "setup" ? TEXT.setup : TEXT.landing}</span>
        {left != null && <b>{left > 0 ? `~${mmss(left)}` : TEXT.over}</b>}
      </button>
    );
  }
  if (!ended) return null;
  const close = () => { setShut(l.endedAt!); clearLanding(); };
  return (
    <div className="am-toast" role="status" data-testid="turbo-landed-toast">
      <div className="am-tbody">
        <b>{l.error ? TEXT.failTitle : TEXT.doneTitle}</b>
        <span>{l.error ? l.error :TEXT.done(`$${(l.creditedUsd ?? 0).toFixed(2)}`)}</span>
        <div className="am-tacts">
          <button type="button" className="r2-gold" onClick={() => { close(); openTurbo(l.error ? "add" : "history"); }}>{TEXT.view}</button>
          <button type="button" className="r2-btn" onClick={close}>{TEXT.close}</button>
        </div>
      </div>
    </div>
  );
}

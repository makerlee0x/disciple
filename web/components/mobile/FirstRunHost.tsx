"use client";
/**
 * First run on phones (maker, 2026-11-14; lib/firstRun). One host, mounted by AppShell:
 *  - Lobby: a "Tap a rocket to fly" coach line above the tab bar until the first flight opens.
 *  - First flight: the throttle intro card (BOOST = BUY, DUMP = SELL, STEER), closed with FLY.
 *  - Signed in with $0 on a flight: an "Add cash to board" card (card checkout or Free play), once per flight.
 *  - The first live boost that fills: a big "FIRST BOOST" moment.
 * The Add to Home Screen prompt is InstallPrompt's job.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { isCollapsibleRoute } from "@/components/Sidebar";
import { loadRun, saveRun, showFlightIntro, showPickCoach } from "@/lib/firstRun";
import { openCash } from "@/lib/cashLink";
import { WALLET_ID_EVENT, walletId } from "@/lib/walletCta";
import { withBase } from "@/lib/base-path";
import { haptic } from "@/lib/game/haptics";

const phoneNow = () => typeof window !== "undefined" && matchMedia("(max-width: 760px)").matches;

export const INTRO_COPY = {
  title: "HOW TO FLY",
  boost: ["BOOST", "= BUY", "slide up"],
  dump: ["DUMP", "= SELL", "slide down"],
  steer: ["STEER", "", "drag the sky"],
  line: "Every boost and dump is a real trade.",
  line2: "Let go of the lever to fire.",
  go: "FLY",
} as const;

export default function FirstRunHost() {
  const path = usePathname() ?? "/";
  const game = isCollapsibleRoute(path);
  const sim = path.startsWith("/flight/sim");
  const [phone, setPhone] = useState(false);
  const [run, setRun] = useState(loadRun);
  const [signedIn, setSignedIn] = useState(false);
  const [cash, setCash] = useState<number | null>(null);
  const [cashCard, setCashCard] = useState(false);
  const [firstBoost, setFirstBoost] = useState(false);
  // the phone flight HUD is up (PhoneHud sets html.ap-phone): a hub or loading screen on a game route doesn't count
  const [hud, setHud] = useState(false);
  useEffect(() => {
    const de = document.documentElement, f = () => setHud(de.classList.contains("ap-phone"));
    f(); const mo = new MutationObserver(f); mo.observe(de, { attributes: true, attributeFilter: ["class"] }); return () => mo.disconnect();
  }, []);

  useEffect(() => { const m = matchMedia("(max-width: 760px)"); const f = () => setPhone(m.matches); f(); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  useEffect(() => { setRun(loadRun()); const f = () => setRun(loadRun()); addEventListener("disciple:firstrun", f); return () => removeEventListener("disciple:firstrun", f); }, []);
  useEffect(() => { setSignedIn(!!walletId()); const f = (e: Event) => setSignedIn(!!(e as CustomEvent).detail); addEventListener(WALLET_ID_EVENT, f); return () => removeEventListener(WALLET_ID_EVENT, f); }, []);
  // a flight opened: step 1 is done
  useEffect(() => { if (game && !loadRun().flown) saveRun({ flown: true }); setCashCard(false); }, [game, path]);
  // the phone header's cash (TradeBridge disciple:phonestats)
  useEffect(() => {
    const read = (d: unknown) => { const c = (d as { cash?: number | null } | null)?.cash; setCash(typeof c === "number" ? c : null); };
    read((window as unknown as { __phoneStats?: unknown }).__phoneStats);
    const f = (e: Event) => read((e as CustomEvent).detail);
    addEventListener("disciple:phonestats", f); return () => removeEventListener("disciple:phonestats", f);
  }, []);
  // signed in, on a live flight, intro closed, $0: offer cash once per flight
  useEffect(() => {
    if (!game || !hud || sim || !phone || !signedIn || !run.intro) return;
    if (cash !== null && cash < 0.5) { const t = setTimeout(() => setCashCard(true), 900); return () => clearTimeout(t); }
    setCashCard(false);
  }, [game, hud, sim, phone, signedIn, cash, run.intro]);
  // live boosts that filled: count them; the first one gets its moment
  useEffect(() => {
    const f = (e: Event) => {
      const d = (e as CustomEvent<{ side?: string }>).detail;
      if (d?.side !== "buy") return;
      const r = loadRun(); saveRun({ boosts: r.boosts + 1 });
      if (r.boosts === 0) { setFirstBoost(true); haptic("celebrate"); setTimeout(() => setFirstBoost(false), 3200); }
    };
    addEventListener("disciple:fillreceipt", f); return () => removeEventListener("disciple:fillreceipt", f);
  }, []);

  if (!phone && !phoneNow()) return null;

  if (!game) return showPickCoach(run, true) && (path === "/" || path === "") ? (
    <div className="fr-coach" role="status" data-testid="fr-coach"><span aria-hidden className="fr-dot" />Tap any rocket to jump in</div>
  ) : null;

  return (
    <>
      {hud && showFlightIntro(run) && (
        <div className="fr-intro" role="dialog" aria-modal="true" aria-labelledby="fr-intro-t" data-testid="fr-intro">
          <div className="fr-card">
            <h2 id="fr-intro-t">{INTRO_COPY.title}</h2>
            <div className="fr-how">
              {([["b", "↑", INTRO_COPY.boost], ["d", "↓", INTRO_COPY.dump], ["s", "↔", INTRO_COPY.steer]] as const).map(([k, ic, [t, eq, sub]]) => (
                <div key={k} className={`fr-hw ${k}`}><i aria-hidden>{ic}</i><b>{t}</b><em>{eq || " "}</em><small>{sub}</small></div>
              ))}
            </div>
            <p className="fr-one">{INTRO_COPY.line}<br />{INTRO_COPY.line2}</p>
            <button type="button" className="r2-gold fr-go" data-testid="fr-go" onClick={() => { saveRun({ intro: true }); haptic("tap", true); }}>{INTRO_COPY.go}</button>
          </div>
        </div>
      )}
      {cashCard && (
        <div className="fr-cash" role="region" aria-label="Add cash" data-testid="fr-cash">
          <div className="fr-cash-t"><b>Add cash to board</b><span>Boosts spend your cash. Card or Apple Pay works.</span></div>
          <div className="fr-cash-b">
            <button type="button" className="r2-gold" onClick={() => { setCashCard(false); openCash("add"); }}>Add cash</button>
            <a className="r2-btn" href={withBase("/flight/sim")}>Free play</a>
          </div>
          <button type="button" className="fr-x" aria-label="Close" onClick={() => setCashCard(false)}>
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}
      {firstBoost && <div className="fr-first" role="status" data-testid="fr-first"><b>FIRST BOOST!</b><span>You're aboard, pilot.</span></div>}
    </>
  );
}

"use client";
/**
 * First run on phones (maker, 2026-11-14; lib/firstRun). One host, mounted by AppShell:
 *  - Lobby: a "Swipe to pick a mode, tap to play" coach line (matches Pick a mode) above the tab bar until the first flight opens.
 *  - First flight: teach by playing (Grok playbook pick, maker 2026-11-16): no How to fly card. A finger slides up the throttle
 *    lever with one line ("SLIDE UP TO BOOST · let go to fire") until the pilot pulls the lever for the first time.
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
  boost: "SLIDE UP TO BOOST",
  fire: "let go to fire",
} as const;

/** where the throttle handle is (PhoneThrottle data-testid="thr-handle"); null while it isn't on screen (signed out, sheet open) */
function useHandleRect(on: boolean) {
  const [r, setR] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!on) { setR(null); return; }
    let raf = 0;
    const f = () => { const el = document.querySelector<HTMLElement>('[data-testid="thr-handle"]'); const b = el?.getBoundingClientRect();
      setR((old) => (!b || !b.width ? null : old && Math.abs(old.x - b.x) < 1 && Math.abs(old.y - b.y) < 1 ? old : b)); raf = window.setTimeout(f, 250) as unknown as number; };
    f(); return () => clearTimeout(raf);
  }, [on]);
  return r;
}

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
  // Lobby coach: on the signed-out landing the first screen is the hero (its own Play now), and a fixed pill there covered
  // the hero's last line. Show it once the hero has scrolled away, or right away on the signed-in lobby (no landing hero).
  const [coachRoom, setCoachRoom] = useState(false);
  useEffect(() => {
    const f = () => setCoachRoom(!document.getElementById("so-hero-title") || window.scrollY > window.innerHeight * 0.6);
    f(); addEventListener("scroll", f, { passive: true }); const t = window.setInterval(f, 1500);
    return () => { removeEventListener("scroll", f); clearInterval(t); };
  }, [path]);
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

  // first flight coach: gone for good once the pilot grabs the lever and lets go
  const coachOn = hud && showFlightIntro(run);
  const handle = useHandleRect(coachOn);
  useEffect(() => {
    if (!coachOn) return;
    let grabbed = false;
    const down = (e: PointerEvent) => { if ((e.target as HTMLElement | null)?.closest?.('[data-testid="thr-handle"]')) grabbed = true; };
    const up = () => { if (grabbed) { saveRun({ intro: true }); haptic("tap", true); } };
    addEventListener("pointerdown", down, true); addEventListener("pointerup", up, true);
    return () => { removeEventListener("pointerdown", down, true); removeEventListener("pointerup", up, true); };
  }, [coachOn]);

  if (!phone && !phoneNow()) return null;

  if (!game) return showPickCoach(run, true) && (path === "/" || path === "") && coachRoom ? (
    <div className="fr-coach" role="status" data-testid="fr-coach"><span aria-hidden className="fr-dot" />Swipe to pick a mode, tap to play</div>
  ) : null;

  return (
    <>
      {coachOn && handle && (
        <div className="fr-lev" role="status" data-testid="fr-coach-lever" aria-label={`${INTRO_COPY.boost}, ${INTRO_COPY.fire}`}
          style={{ left: handle.left + handle.width / 2, top: handle.top + handle.height / 2 }}>
          <span className="fr-lev-tip" aria-hidden><b>{INTRO_COPY.boost}</b><small>{INTRO_COPY.fire}</small></span>
          <span className="fr-lev-trail" aria-hidden />
          <svg className="fr-lev-hand" width="44" height="52" viewBox="0 0 44 52" aria-hidden>
            <path d="M16 6a4 4 0 0 1 8 0v16l2-1a4 4 0 0 1 5 2l1 1a4 4 0 0 1 5 2l.5.8A4 4 0 0 1 42 30v8c0 8-6 13-14 13h-3c-5 0-8-2-11-6L6 34a4 4 0 0 1 6-5l4 4V6z" fill="#FFF6DC" stroke="#121327" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </div>
      )}
      {cashCard && (
        <div className="fr-cash" role="region" aria-label="Add cash" data-testid="fr-cash">
          <div className="fr-cash-t"><b>Add cash to board</b><span>Card or Apple Pay</span></div>
          <div className="fr-cash-b">
            <button type="button" className="r2-gold" onClick={() => { setCashCard(false); openCash("add"); }}>Add cash</button>
            <a className="r2-btn" href={withBase("/flight/sim")}>Free play</a>
          </div>
          <button type="button" className="fr-x" aria-label="Close" onClick={() => setCashCard(false)}>
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}
      {firstBoost && <div className="fr-first" role="status" data-testid="fr-first"><b>FIRST BOOST!</b></div>}
    </>
  );
}

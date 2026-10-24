"use client";
/**
 * EXIT CONFIRM (flight page): "Leave the mission?" before the player leaves a flight. Copy lives in lib/game/i18n (exitc.*);
 * decisions (which clicks / Back presses leave the flight) live in lib/game/exitGuard so scripts/test-exit-confirm.mjs checks them.
 *
 * Hooked while `active` (engine booted, not a replay):
 *   - the exit ✕ (#exitX, FlightCanvas) and any other same-tab link off the flight route: document capture-phase click
 *   - browser Back: one same-URL guard history entry; popping it opens the dialog (Stay re-arms it, Leave goes back for real)
 *   - tab close / reload / typed URL: the browser's generic beforeunload prompt only
 *   - EXIT_REQUEST_EVENT (disciple:exit-request {href}) for any other surface
 * Keys: none while closed (trading hotkeys untouched). While open: Esc = Stay, Tab wraps Stay ↔ Leave, Enter/Space press the
 * focused button, every other key aimed at the game is swallowed (same rule as the ESC SettingsMenu). Backdrop click = Stay.
 * Look: the SettingsMenu card (navy glass + gold hairline); Stay is the gold primary, Leave the quiet ghost.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/game/i18n";
import { EXIT_REQUEST_EVENT, GUARD_KEY, OPT_OUT_ATTR, backNeedsConfirm, guardState, interceptClick, leavesFlight, nextFocus } from "@/lib/game/exitGuard";

const GOLD = "#ffe7a3", INK = "#fff7df", DIM = "rgba(220,228,255,.72)";
type Pending = { kind: "href"; href: string } | { kind: "back" };

export default function ExitConfirm({ active }: { active: boolean }) {
  const t = useT();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const stayRef = useRef<HTMLButtonElement>(null), leaveRef = useRef<HTMLButtonElement>(null), boxRef = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const flightHref = useRef("");
  const st = useRef({ active, pending }); st.current = { active, pending };

  const ask = useCallback((p: Pending) => { if (!leaving.current) setPending(p); }, []);
  const stay = useCallback(() => {
    const p = st.current.pending; setPending(null);
    if (p?.kind === "back") try { history.pushState(guardState(history.state), "", flightHref.current || location.href); } catch { /* */ }   // re-arm Back
    // drop focus (the ✕ link / a button) so Enter = chat and Space = BOOST keep going to the game
    window.setTimeout(() => { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body) a.blur?.(); }, 0);
  }, []);
  const leave = useCallback(() => {
    const p = st.current.pending; leaving.current = true; setPending(null);
    if (!p) return;
    if (p.kind === "back") { history.back(); return; }
    let same = false; try { same = new URL(p.href).origin === location.origin; } catch { /* */ }
    if (same) { const u = new URL(p.href); router.push(u.pathname + u.search + u.hash); } else location.assign(p.href);
  }, [router]);

  // links: capture phase on document so it runs before next/link's own onClick
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (leaving.current || st.current.pending) return;
      const el = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const href = interceptClick(e, el && { href: el.href, target: el.getAttribute("target"), download: el.hasAttribute("download"), optOut: el.hasAttribute(OPT_OUT_ATTR) }, location.href);
      if (!href) return;
      e.preventDefault(); e.stopPropagation();
      ask({ kind: "href", href });
    };
    const onReq = (e: Event) => { const href = (e as CustomEvent<{ href?: string }>).detail?.href || "/";
      const abs = new URL(href, location.href).href; if (leavesFlight(location.href, abs)) ask({ kind: "href", href: abs }); };
    document.addEventListener("click", onClick, true); addEventListener(EXIT_REQUEST_EVENT, onReq);
    return () => { document.removeEventListener("click", onClick, true); removeEventListener(EXIT_REQUEST_EVENT, onReq); };
  }, [active, ask]);

  // Back button: one guard entry with the same URL (Next's fields kept, so its router sees no navigation)
  useEffect(() => {
    if (!active) return;
    flightHref.current = location.href;
    try { if (!(history.state && (history.state as Record<string, unknown>)[GUARD_KEY])) history.pushState(guardState(history.state), "", location.href); } catch { /* */ }
    const onPop = (e: PopStateEvent) => { if (!leaving.current && backNeedsConfirm(e.state, location.href, flightHref.current)) ask({ kind: "back" }); };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [active, ask]);

  // real tab close / reload only: generic browser prompt, only while a flight is active
  useEffect(() => {
    if (!active) return;
    const onBefore = (e: BeforeUnloadEvent) => { if (leaving.current) return; e.preventDefault(); e.returnValue = ""; };
    addEventListener("beforeunload", onBefore);
    return () => removeEventListener("beforeunload", onBefore);
  }, [active]);

  // open: pause the engine's held keys (disciple:menu), focus Stay; keys only while open
  const open = !!pending;
  useEffect(() => {
    if (!open) return;
    dispatchEvent(new CustomEvent("disciple:menu", { detail: { open: true } }));
    window.setTimeout(() => stayRef.current?.focus(), 0);
    const k = (e: KeyboardEvent) => {
      if (e.code === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); stay(); return; }
      if (e.code === "Tab") { e.preventDefault(); e.stopImmediatePropagation();
        const i = document.activeElement === leaveRef.current ? 1 : 0; (nextFocus(i, e.shiftKey) ? leaveRef : stayRef).current?.focus(); return; }
      if (boxRef.current && boxRef.current.contains(e.target as Node)) return;   // Enter / Space on Stay / Leave work natively
      e.stopImmediatePropagation();   // nothing else reaches the game while the dialog is up
    };
    addEventListener("keydown", k, true);
    return () => { removeEventListener("keydown", k, true); dispatchEvent(new CustomEvent("disciple:menu", { detail: { open: false } })); };
  }, [open, stay]);

  if (!pending) return null;
  const card: React.CSSProperties = { position: "relative", width: 380, maxWidth: "92vw", display: "flex", flexDirection: "column", gap: 14, padding: "20px 20px 18px", borderRadius: 16, outline: "none",
    background: "linear-gradient(180deg,rgba(16,14,40,.96),rgba(8,10,26,.95))", border: "1px solid rgba(255,231,163,.5)", boxShadow: "0 0 0 1px rgba(0,0,0,.4), 0 24px 70px rgba(0,0,0,.65), 0 0 30px rgba(255,220,150,.12)",
    color: INK, font: "12px ui-monospace,monospace" };
  const base: React.CSSProperties = { all: "unset", cursor: "pointer", boxSizing: "border-box", padding: "10px 16px", borderRadius: 10, fontWeight: 800, fontSize: 12, letterSpacing: ".06em", textAlign: "center", minWidth: 96 };
  const primary: React.CSSProperties = { ...base, background: GOLD, color: "#151830", border: "1px solid rgba(255,231,163,.95)", boxShadow: "0 0 18px rgba(255,220,150,.35)" };
  const ghost: React.CSSProperties = { ...base, fontWeight: 600, background: "transparent", color: DIM, border: "1px solid rgba(255,255,255,.16)" };
  return (
    <div data-testid="exit-confirm" role="alertdialog" aria-modal="true" aria-labelledby="exitc-title" aria-describedby="exitc-body"
      onPointerDown={(e) => { if (e.target === e.currentTarget) stay(); }}
      style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", background: "rgba(4,5,14,.55)", backdropFilter: "blur(3px)" }}>
      <div ref={boxRef} tabIndex={-1} style={card} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
        <div id="exitc-title" style={{ color: GOLD, fontWeight: 800, letterSpacing: ".08em", fontSize: 14 }}>{t("exitc.title")}</div>
        <div id="exitc-body" style={{ color: DIM, fontSize: 12, lineHeight: 1.5 }}>{t("exitc.body")}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
          <button ref={leaveRef} type="button" data-testid="exit-confirm-leave" onClick={leave} style={ghost}>{t("exitc.leave")}</button>
          <button ref={stayRef} type="button" data-testid="exit-confirm-stay" onClick={stay} autoFocus style={primary}>{t("exitc.stay")}</button>
        </div>
      </div>
    </div>
  );
}

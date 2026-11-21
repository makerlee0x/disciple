/**
 * Turbo pill (maker 2026-11-20): the player's Turbo cash as a glowing cyan pill in the Duel and Climb lobby headers,
 * next to the rating chip. Tap it for the Turbo popup (components/turbo/TurboCashHost): add from Cash, withdraw to Cash,
 * and the Advanced tab with the Lighter record (fills, deposits, withdrawals).
 *  - Signed in only. Reads Lighter even on Simulator (turboCash wantTurboRead), so the balance shows before the switch.
 *  - Blocked country (lib/turbo/region): the iPhone app shows no pill (like the Real money switch); the web shows it
 *    locked, no balance read and no popup.
 * Plain DOM like the Real money switch (lib/turbo/realSwitch), since the lobby header is the engine's markup.
 */
import { isNativeApp } from "@/lib/native";
import { onWallet } from "@/lib/walletState";
import { TURBO_BLOCKED_NOTE, turboBlockedCached, turboRegion } from "./region";
import { onTurboCash, setTurboWallet, wantTurboRead } from "./turboCash";

/** CustomEvent: open the Turbo popup (components/turbo/TurboCashHost). detail.tab = "add" | "out" | "history" */
export const OPEN_TURBO_EVENT = "disciple:openturbo";
export type TurboTab = "add" | "out" | "history";
export function openTurbo(tab: TurboTab = "add") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_TURBO_EVENT, { detail: { tab } }));
}

const CSS = `
.duel-root .tcp-pill[hidden]{display:none}
.duel-root .tcp-pill{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 12px 0 9px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(68,212,226,.8);background:linear-gradient(180deg,rgba(68,212,226,.24),rgba(68,212,226,.07)),rgba(10,14,24,.88);
  color:#EAFDFF;font:800 16px/1 var(--f-game);letter-spacing:.4px;white-space:nowrap;font-variant-numeric:tabular-nums;
  box-shadow:inset 0 0 0 1px rgba(68,212,226,.14),0 0 12px rgba(68,212,226,.5),0 0 30px rgba(68,212,226,.2);
  text-shadow:0 0 10px rgba(68,212,226,.55);animation:tcpGlow 2.8s ease-in-out infinite}
.duel-root .tcp-pill svg{flex:none;color:#44D4E2;filter:drop-shadow(0 0 4px rgba(68,212,226,.8))}
.duel-root .tcp-pill .tcp-add{display:grid;place-items:center;width:18px;height:18px;margin-left:2px;border-radius:50%;background:#44D4E2;color:#07202A;font:900 15px/1 var(--f-game);text-shadow:none}
.duel-root .tcp-pill:hover{border-color:#7DE6F0;box-shadow:inset 0 0 0 1px rgba(68,212,226,.2),0 0 16px rgba(68,212,226,.65),0 0 38px rgba(68,212,226,.28)}
.duel-root .tcp-pill:focus-visible{outline:3px solid #fff;outline-offset:2px}
.duel-root .tcp-pill.lock{cursor:not-allowed;animation:none;border-color:var(--line);background:rgba(18,19,39,.7);color:var(--muted);text-shadow:none;box-shadow:none}
.duel-root .tcp-pill.lock svg{color:var(--muted);filter:none}
@keyframes tcpGlow{0%,100%{box-shadow:inset 0 0 0 1px rgba(68,212,226,.14),0 0 10px rgba(68,212,226,.42),0 0 26px rgba(68,212,226,.16)}50%{box-shadow:inset 0 0 0 1px rgba(68,212,226,.2),0 0 16px rgba(68,212,226,.62),0 0 36px rgba(68,212,226,.26)}}
@media (max-width:560px){.duel-root .pre-top>.tcp-pill{grid-column:1/-1;justify-self:center;margin-top:2px}}
@media (prefers-reduced-motion:reduce){.duel-root .tcp-pill{animation:none}}
`;
const BOLT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2 4 13.5h6.5L9 22l10-12.5h-6.6z"/></svg>`;
const LOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

const money = (n: number) => `$${(Math.floor(n * 100 + 1e-6) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** puts the pill in the lobby header (left of the rating chip); returns the clean-up */
export function mountTurboPill(root: HTMLElement): () => void {
  const top = root.querySelector(".pre-top");
  if (!top) return () => {};
  if (!document.getElementById("tcp-pill-css")) {
    const st = document.createElement("style"); st.id = "tcp-pill-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "tcp-pill"; btn.hidden = true; btn.dataset.testid = "turbo-pill";
  // the gear sits in .pre-r with the rating chip (engine host.settings); without it, next to the chip
  const slot = top.querySelector(".pre-r") ?? top.querySelector(".me-chip")?.parentElement ?? top;
  // phones: the header has no room beside the title, so the pill takes its own centred row under it
  const phone = window.matchMedia("(max-width:560px)");
  const place = () => { if (phone.matches) top.appendChild(btn); else slot.insertBefore(btn, slot.firstChild); };
  place();
  phone.addEventListener("change", place);

  let addr: string | null = null, usd = 0, on = false, known = false, gone = false;
  let stopRead: (() => void) | null = null;
  const blocked = () => turboBlockedCached();
  const paint = () => {
    if (!known || !addr || isNativeApp()) { btn.hidden = true; return; }   // no Turbo cash in the app (App Review 3.1.5(iii))
    btn.hidden = false;
    if (blocked()) {
      btn.classList.add("lock"); btn.disabled = true; btn.title = TURBO_BLOCKED_NOTE;
      btn.setAttribute("aria-label", TURBO_BLOCKED_NOTE);
      btn.innerHTML = `${LOCK}<span>Turbo</span>`;
      return;
    }
    if (!on) { btn.hidden = true; return; }   // until Lighter answers (and never where the server has it off)
    btn.classList.remove("lock"); btn.disabled = false; btn.title = "";
    btn.setAttribute("aria-label", `Turbo cash ${money(usd)}. Add or withdraw`);
    btn.innerHTML = `${BOLT}<span class="tcp-v">${money(usd)}</span><span class="tcp-add" aria-hidden="true">+</span>`;
  };
  const read = () => {
    const want = known && !!addr && !blocked();
    if (want && !stopRead) stopRead = wantTurboRead();
    if (!want && stopRead) { stopRead(); stopRead = null; }
  };
  const offCash = onTurboCash((t) => { usd = t.usd; on = t.canAdd; paint(); });
  const offWallet = onWallet((a) => { addr = a?.toLowerCase() ?? null; setTurboWallet(addr); read(); paint(); });
  void turboRegion().then(() => { if (gone) return; known = true; read(); paint(); });
  btn.addEventListener("click", () => { if (!blocked()) openTurbo("add"); });
  return () => { gone = true; phone.removeEventListener("change", place); offCash(); offWallet(); stopRead?.(); btn.remove(); };
}

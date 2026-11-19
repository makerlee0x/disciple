/**
 * Simulator / Real money switch at the top of the Duel and Climb lobbies (maker 2026-11-19). It drives the same
 * per-browser setting as ?lighter=1 (lib/lighter/duel lighterWanted), then reloads, since each mode reads it once as it
 * sets up. Where real-money Turbo can't run (a blocked country, lib/turbo/region, and the iPhone app) there is no
 * switch at all and the mode runs on Simulator cash (maker 2026-11-19: "we just dont show it at all"). html.turbo-real is on while real money is live, so labels can follow it
 * ("fuel" vs "Simulator cash" in the engine).
 */
import { isNativeApp } from "@/lib/native";
import { lighterWanted, setLighterWanted } from "@/lib/lighter/duel";
import { turboBlockedCached, turboRegion } from "@/lib/turbo/region";

const CSS = `
.duel-root .rm-sw[hidden]{display:none}
.duel-root .rm-sw{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;font:800 15px/1 var(--f-game);letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.duel-root .rm-sw .rl{opacity:.55;transition:opacity .15s,color .15s}
.duel-root .rm-sw .rl.on{opacity:1;color:#F2F3F7}
.duel-root .rm-sw .rl.on.rr{color:var(--gold)}
.duel-root .rm-sw button{position:relative;flex:none;width:52px;height:30px;padding:0;border-radius:999px;border:1px solid var(--line);background:rgba(18,19,39,.85);cursor:pointer}
.duel-root .rm-sw button i{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#D7D9E4;transition:transform .18s ease,background .18s}
.duel-root .rm-sw button[aria-checked=true]{border-color:rgba(242,193,78,.7);background:rgba(242,193,78,.18)}
.duel-root .rm-sw button[aria-checked=true] i{transform:translateX(22px);background:var(--gold)}
.duel-root .rm-sw button:focus-visible{outline:3px solid #fff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.duel-root .rm-sw button i{transition:none}}
`;

/** puts the switch above the lobby's side column; returns the clean-up */
export function mountRealSwitch(root: HTMLElement): () => void {
  const side = root.querySelector(".pre-side");
  if (!side) return () => {};
  if (!document.getElementById("rm-sw-css")) {
    const st = document.createElement("style"); st.id = "rm-sw-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const real = lighterWanted();
  const el = document.createElement("div");
  el.className = "rm-sw";
  el.innerHTML = `<span class="rl rs">Simulator</span><button type="button" role="switch" aria-label="Real money"><i></i></button><span class="rl rr">Real money</span>`;
  side.prepend(el);
  const btn = el.querySelector("button")!, html = document.documentElement;
  const paint = (on: boolean) => {
    btn.setAttribute("aria-checked", String(on));
    el.querySelector(".rs")!.classList.toggle("on", !on);
    el.querySelector(".rr")!.classList.toggle("on", on);
    html.classList.toggle("turbo-real", on);
  };
  const locked = () => isNativeApp() || turboBlockedCached();
  const show = () => { el.hidden = locked(); paint(lighterWanted() && !locked()); };
  el.hidden = true;   // until the country is known, so a blocked visitor never sees it
  if (!isNativeApp()) paint(real && !locked());
  let gone = false;
  void turboRegion().then(() => { if (!gone) show(); });
  btn.addEventListener("click", () => {
    if (locked()) return;
    setLighterWanted(btn.getAttribute("aria-checked") !== "true");
    const u = new URL(location.href); u.searchParams.delete("lighter");
    location.replace(u.toString());
  });
  return () => { gone = true; el.remove(); html.classList.remove("turbo-real"); };
}

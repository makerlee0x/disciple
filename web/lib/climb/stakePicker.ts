/**
 * Climb stake picker (maker 2026-11-20): right under the Simulator / Real money switch (lib/turbo/realSwitch), four
 * boxes: three presets and a custom $ amount, all inside the margin cap (lib/climb/rules climbStakeCap). The choice
 * is kept per browser, apart for Simulator and Real money. Shown on the level select and free mode set-up only (a
 * result screen names the stake of its PLAY AGAIN button, so the stake doesn't change under it).
 */
import { CLIMB_MIN_STAKE, type StakeChoice } from "@/lib/climb/rules";

const KEY = "disciple.climb.stake.v1";
type Mode = "sim" | "real";

export function readStakeChoice(mode: Mode): StakeChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}")?.[mode];
    if (v && typeof v.c === "number" && Number.isFinite(v.c) && v.c > 0) return { c: v.c };
    if (v && typeof v.p === "number" && v.p >= 0 && v.p <= 2) return { p: Math.floor(v.p) };
  } catch { /* private mode */ }
  return { p: 0 };
}
export function saveStakeChoice(mode: Mode, c: StakeChoice) {
  try { const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") || {}; all[mode] = c; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* memory only */ }
}

const CSS = `
.duel-root .cl-stake[hidden]{display:none}
.duel-root .cl-stake{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%}
.duel-root .cl-stake>span{font:800 13px/1 var(--f-game);letter-spacing:1px;text-transform:uppercase;color:var(--muted);text-align:center}
.duel-root .cl-stake .row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.duel-root .cl-stake button,.duel-root .cl-stake label{height:52px;border-radius:12px;background:#23262F;border:2px solid #2E323A;color:var(--text);font:800 18px/1 var(--f-game);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer;min-width:0;padding:0 6px}
.duel-root .cl-stake button small{font:700 10px/1 var(--f-game);letter-spacing:.12em;color:var(--muted)}
.duel-root .cl-stake .on{border-color:var(--gold);background:rgba(242,193,78,.16)}
.duel-root .cl-stake label{flex-direction:row;gap:2px;cursor:text}
.duel-root .cl-stake label b{font:800 18px/1 var(--f-game);color:var(--muted)}
.duel-root .cl-stake label.on b{color:var(--text)}
.duel-root .cl-stake input{width:100%;min-width:0;background:none;border:0;outline:none;color:var(--text);font:800 18px/1 var(--f-game);padding:0;-moz-appearance:textfield}
.duel-root .cl-stake input::placeholder{color:var(--muted);opacity:1;letter-spacing:.06em;font-size:14px}
.duel-root .cl-stake input::-webkit-outer-spin-button,.duel-root .cl-stake input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.duel-root .cl-stake button:focus-visible,.duel-root .cl-stake label:focus-within{outline:3px solid #fff;outline-offset:2px}
@media (max-width:420px){.duel-root .cl-stake .row{gap:6px}.duel-root .cl-stake button,.duel-root .cl-stake label,.duel-root .cl-stake input,.duel-root .cl-stake label b{font-size:16px}}
`;

const m2 = (v: number) => "$" + (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v % 1 ? v.toFixed(2) : String(v));

export interface StakeView { choice: StakeChoice; presets: number[]; cap: number; stake: number }

/** mounts the picker under the switch; `view` is read on each paint, `pick` gets the new choice */
export function mountStakePicker(root: HTMLElement, view: () => StakeView, pick: (c: StakeChoice) => void): { paint(): void; off(): void } {
  const side = root.querySelector(".pre-side");
  if (!side) return { paint() {}, off() {} };
  if (!document.getElementById("cl-stake-css")) {
    const st = document.createElement("style"); st.id = "cl-stake-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.className = "cl-stake"; el.dataset.testid = "climb-stake";
  el.setAttribute("role", "group"); el.setAttribute("aria-label", "Per round");
  el.innerHTML = `<span>Per round</span><div class="row"><button type="button" data-p="0"></button><button type="button" data-p="1"></button><button type="button" data-p="2"></button><label><b>$</b><input type="number" inputmode="decimal" min="${CLIMB_MIN_STAKE}" step="0.01" placeholder="Custom" aria-label="Custom amount per round"></label></div>`;
  const sw = side.querySelector(".rm-sw");
  if (sw) sw.after(el); else side.prepend(el);
  const btns = [...el.querySelectorAll<HTMLButtonElement>("button[data-p]")];
  const lab = el.querySelector("label")!, inp = el.querySelector("input")!;

  const paint = () => {
    const v = view();
    btns.forEach((b, i) => {
      const on = "p" in v.choice && v.choice.p === i;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
      b.innerHTML = `${m2(v.presets[i])}${i === btns.length - 1 ? "<small>MAX</small>" : ""}`;
    });
    const custom = "c" in v.choice;
    lab.classList.toggle("on", custom);
    inp.max = String(v.cap);
    if (document.activeElement !== inp) inp.value = custom ? String(v.stake) : "";
  };
  btns.forEach((b) => b.addEventListener("click", () => { pick({ p: +b.dataset.p! }); paint(); }));
  // a typed amount applies on Enter / leaving the box, clamped to [$2, cap]; an emptied box goes back to the first preset
  const commit = () => {
    const raw = inp.value.trim();
    if (!raw) { if ("c" in view().choice) pick({ p: 0 }); paint(); return; }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) pick({ c: n });
    paint();
  };
  inp.addEventListener("change", commit);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { inp.blur(); } });

  // only on the level select and free mode set-up (engine: #cres data-k="free")
  const lv = root.querySelector<HTMLElement>("#climb"), cr = root.querySelector<HTMLElement>("#cres");
  const vis = () => { el.hidden = !((lv && !lv.hidden) || (cr && !cr.hidden && cr.dataset.k === "free")); };
  const mo = new MutationObserver(vis);
  [lv, cr].forEach((p) => p && mo.observe(p, { attributes: true, attributeFilter: ["hidden", "data-k"] }));
  vis(); paint();
  return { paint, off: () => { mo.disconnect(); el.remove(); } };
}

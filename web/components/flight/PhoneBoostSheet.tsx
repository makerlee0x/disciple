"use client";
/**
 * Phone gear sheet (throttle prototype "BOOST AMOUNTS" sheet, maker 2026-11-14: the old Swap settings popup read as the
 * older design). Bottom sheet: the lever's four boost notches (editable, $3 minimum, saved as you type), Small / Default /
 * Big quick sets, then Sound effects, Music (plays the house radio) and Vibration, which used to live behind the ☰ menu.
 * Desktop keeps SwapSettingsModal.
 */
import { useEffect, useState } from "react";
import { DEFAULT_BUY, MIN_BOOST_USD, validBoost, type SwapSettings } from "@/lib/trade/swapSettings";
import { setGameSettings, useGameSettings } from "@/lib/game/settings";
import { getGameRadio } from "@/lib/game/radio";
import { resumeAudio } from "@/lib/game/audio";

const G = "var(--dsc-font-game, 'Barlow Condensed', sans-serif)";
const QUICK = [{ k: "Small", v: [3, 5, 10, 20] }, { k: "Default", v: DEFAULT_BUY.slice() }, { k: "Big", v: [25, 50, 100, 250] }];
const fmt = (v: number) => `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
const MAX = 10_000;

/** Parse the four fields: sorted amounts, or the reason they can't be saved. Pure, tested. */
export function readAmounts(raw: string[]): { ok: true; v: number[] } | { ok: false; bad: boolean[]; msg: string } {
  const n = raw.map((s) => Math.round(parseFloat(s.replace(/[^0-9.]/g, "")) * 100) / 100);
  const bad = n.map((x) => !(validBoost(x) && x <= MAX));
  if (bad.some(Boolean)) return { ok: false, bad, msg: `Each amount needs to be at least $${MIN_BOOST_USD} (network fees) and at most $10,000.` };
  const v = n.slice().sort((a, b) => a - b);
  if (new Set(v).size < v.length) return { ok: false, bad: bad.map(() => false), msg: "Use four different amounts." };
  return { ok: true, v };
}

export default function PhoneBoostSheet({ initial, onChange, onClose }: {
  initial: SwapSettings; onChange: (s: SwapSettings) => void; onClose: () => void;
}) {
  const start = initial.buy && initial.buy.length === 4 ? initial.buy : DEFAULT_BUY;
  const [vals, setVals] = useState<string[]>(start.map(String));
  const [cur, setCur] = useState<number[]>(start.slice());
  const [bad, setBad] = useState<boolean[]>([false, false, false, false]);
  const [msg, setMsg] = useState<{ t: string; err?: boolean }>({ t: `Minimum $${MIN_BOOST_USD}, which covers network fees.` });
  const gs = useGameSettings();
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const apply = (v: number[]) => {
    setCur(v);
    const isDefault = v.join(",") === DEFAULT_BUY.join(",");
    onChange({ ...initial, buy: isDefault ? null : v });
    setMsg({ t: `Saved. Your lever now reads ${v.map(fmt).join(", ")}.` });
  };
  const edit = (i: number, s: string, final = false) => {
    const next = vals.slice(); next[i] = s; setVals(next);
    const r = readAmounts(next);
    if (!r.ok) { setBad(r.bad); setMsg({ t: r.msg, err: true }); return; }
    setBad([false, false, false, false]);
    if (r.v.join(",") !== cur.join(",")) apply(r.v); else if (final) setMsg({ t: `Saved. Your lever now reads ${r.v.map(fmt).join(", ")}.` });
    if (final) setVals(r.v.map(String));
  };
  const music = () => {
    if (gs.music.on) { setGameSettings((g) => ({ ...g, music: { ...g.music, on: false } })); return; }
    setGameSettings((g) => ({ ...g, music: { on: true, vol: g.music.vol > 0 ? g.music.vol : 0.5 } }));
    void resumeAudio(); const r = getGameRadio(); r.clearPause(); r.start();
  };
  const rows: { k: string; label: string; on: boolean; flip: () => void }[] = [
    { k: "sfx", label: "Sound effects", on: gs.sfx.on, flip: () => setGameSettings((g) => ({ ...g, sfx: { ...g.sfx, on: !g.sfx.on } })) },
    { k: "music", label: "Music", on: gs.music.on, flip: music },
    { k: "haptics", label: "Vibration", on: gs.haptics, flip: () => { const v = !gs.haptics; setGameSettings((g) => ({ ...g, haptics: v })); if (v) dispatchEvent(new CustomEvent("disciple:haptic", { detail: { k: "boost" } })); } },
  ];

  return (
    <div data-testid="swap-settings" className="pbs-dim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{`
        .pbs-dim { position: fixed; inset: 0; z-index: 80; background: rgba(5,6,14,.45); }
        .pbs { position: absolute; left: 0; right: 0; bottom: 0; max-height: 78%; overflow: auto; border-radius: 22px 22px 0 0; background: #15161B; border-top: 1px solid #2E323A;
          padding: 14px 16px calc(20px + env(safe-area-inset-bottom, 0px)); box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; color: #F2F3F7;
          font-family: var(--dsc-font-ui, Geist, system-ui, sans-serif); animation: pbsUp .22s ease-out; }
        @keyframes pbsUp { from { transform: translateY(40px); opacity: 0 } }
        .pbs header { display: flex; justify-content: space-between; align-items: center; }
        .pbs h2 { margin: 0; font: 800 26px/1 ${G}; letter-spacing: .3px; }
        .pbs h3 { margin: 6px 0 0; font: 800 15px/1 ${G}; letter-spacing: 1.2px; color: #F3DFA8; }
        .pbs .x { height: 36px; padding: 0 14px; border-radius: 10px; border: 0; background: #F2F3F7; color: #121327; font: 800 16px/1 ${G}; cursor: pointer; }
        .pbs .p { margin: 0; font-size: 13px; color: rgba(215,217,228,.8); }
        .pbs .p.err { color: #FF8FBD; }
        .pbs .amts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
        .pbs .amt { position: relative; }
        .pbs .amt span { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font: 800 22px/1 ${G}; color: #F3DFA8; pointer-events: none; }
        .pbs .amt input { width: 100%; box-sizing: border-box; height: 56px; border-radius: 14px; border: 2px solid #2E323A; background: #20222B; color: #F2F3F7;
          font: 800 24px/1 ${G}; padding: 0 6px 0 24px; font-variant-numeric: tabular-nums; touch-action: manipulation; }
        .pbs .amt input:focus { outline: none; border-color: #F2C14E; }
        .pbs .amt input.bad { border-color: #F0307F; }
        .pbs .quick { display: flex; gap: 8px; }
        .pbs .quick button { flex: 1; height: 40px; border-radius: 12px; border: 2px solid #2E323A; background: transparent; color: #F2F3F7; font: 800 17px/1 ${G}; letter-spacing: .4px; cursor: pointer; }
        .pbs .quick button.on { border-color: #F2C14E; color: #F2C14E; }
        .pbs .tog { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 4px 0 14px; border-radius: 14px; background: #20222B; font: 800 19px/1 ${G}; letter-spacing: .3px; cursor: pointer; border: 0; color: #F2F3F7; width: 100%; box-sizing: border-box; }
        .pbs .sw { width: 50px; height: 30px; border-radius: 999px; background: #3A3E4A; position: relative; margin-right: 6px; transition: background .15s; flex: none; }
        .pbs .sw::after { content: ""; position: absolute; left: 3px; top: 3px; width: 24px; height: 24px; border-radius: 50%; background: #F2F3F7; transition: transform .15s; }
        .pbs .tog[aria-checked="true"] .sw { background: #5FF0A0; }
        .pbs .tog[aria-checked="true"] .sw::after { transform: translateX(20px); }
      `}</style>
      <div className="pbs" role="dialog" aria-label="Boost amounts and sound">
        <header><h2>BOOST AMOUNTS</h2><button type="button" className="x" data-testid="swap-done" onClick={onClose}>DONE</button></header>
        <p className="p">The four notches on your lever, bottom to top.</p>
        <div className="amts">
          {vals.map((v, i) => <label key={i} className="amt"><span>$</span>
            <input data-testid={`swap-buy-${i}`} className={bad[i] ? "bad" : ""} inputMode="decimal" enterKeyHint="done" aria-label={`Notch ${i + 1} amount in dollars`}
              value={v} onChange={(e) => edit(i, e.target.value)} onBlur={(e) => edit(i, e.target.value, true)} /></label>)}
        </div>
        <div className="quick">
          {QUICK.map((q) => <button key={q.k} type="button" data-testid={`swap-quick-${q.k.toLowerCase()}`} className={q.v.join(",") === cur.join(",") ? "on" : ""}
            onClick={() => { setVals(q.v.map(String)); setBad([false, false, false, false]); apply(q.v); }}>{q.k}</button>)}
        </div>
        <p className={`p${msg.err ? " err" : ""}`} data-testid="swap-msg" aria-live="polite">{msg.t}</p>
        <h3>SOUND</h3>
        <div data-testid="swap-game" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => <button key={r.k} type="button" role="switch" aria-checked={r.on} className="tog" data-testid={`swap-${r.k}`} onClick={r.flip}>
            {r.label}<span className="sw" aria-hidden /></button>)}
        </div>
      </div>
    </div>
  );
}

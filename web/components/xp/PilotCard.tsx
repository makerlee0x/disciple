"use client";
/** Hangar pilot card: level ring, prestige, total XP, XP to spend, and the prestige button at level 50. */
import { useState } from "react";
import LevelRing from "./LevelRing";
import { prestigeWithXp } from "@/lib/xpClient";
import { MAX_LEVEL, type XpSummary } from "@/lib/xp";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function PilotCard({ xp, wallet, name }: { xp: XpSummary | null; wallet: string | null; name?: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!xp) return null;
  const L = xp.level;
  return (
    <section className="dsc3-panel xp-pilot" data-testid="pilot-card">
      <LevelRing info={L} size={88} />
      <div className="xp-pilot-body">
        {name && <div className="xp-pilot-name">{name}</div>}
        <div className="xp-pilot-rank">
          <span className="dsc3-h2">Level {L.level}</span>
          <span className="xp-prestige">{L.prestige ? `Prestige ${L.prestige} · ${L.prestigeName}` : L.prestigeName}</span>
        </div>
        <div className="dsc3-bar dsc3-bar-climb" role="progressbar" aria-valuemin={0} aria-valuemax={L.need || 1} aria-valuenow={L.into} aria-label="Level progress">
          <i style={{ width: `${Math.round(L.progress * 100)}%` }} />
        </div>
        <div className="xp-pilot-next">{L.level >= MAX_LEVEL ? "Max level" : `${fmt(L.need - L.into)} XP to level ${L.level + 1}`}</div>
        <dl className="xp-pilot-stats">
          <div><dt>Total XP</dt><dd className="dsc3-stat">{fmt(xp.totalXp)}</dd></div>
          <div><dt>XP to spend</dt><dd className="dsc3-stat">{fmt(xp.spendableXp)}</dd></div>
        </dl>
        {L.canPrestige && wallet && (
          <button type="button" className="dsc3-btn dsc3-btn-primary" disabled={busy} data-testid="prestige"
            onClick={async () => { setBusy(true); setNote(""); const r = await prestigeWithXp(wallet); setBusy(false); setNote(r.ok ? "Prestige up. Back to level 1." : r.reason || "Couldn't prestige."); }}>
            {busy ? "Prestiging…" : `Prestige to ${L.prestige + 1}`}
          </button>
        )}
        {note && <p className="xp-note" role="status">{note}</p>}
      </div>
    </section>
  );
}

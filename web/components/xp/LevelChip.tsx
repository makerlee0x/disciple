"use client";
/**
 * Top bar: the pilot's level ring, linking to Trophies (`toastOnly`: the lobby bar, where the ring sits in the wallet
 * strip's pilot chip instead). Also shows a toast when new XP lands
 * ("+150 XP · Boost 3 different rockets"), comparing the newest ledger row between polls.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import LevelRing from "./LevelRing";
import { usePilotWallet, useXp } from "@/lib/xpClient";
import { xpLabel } from "@/lib/xp";

export default function LevelChip({ toastOnly = false }: { toastOnly?: boolean } = {}) {
  const wallet = usePilotWallet();
  const { xp } = useXp(wallet);
  const seen = useRef<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!xp) { seen.current = null; return; }
    const ts = xp.recent.find((r) => r.xp > 0)?.ts ?? 0;
    const prev = seen.current;
    seen.current = Math.max(prev ?? 0, ts);
    if (prev === null || ts <= prev) return;
    const fresh = xp.recent.filter((r) => r.xp > 0 && r.ts > prev);
    const total = fresh.reduce((a, r) => a + r.xp, 0);
    setToast(fresh.length === 1 ? `${xpLabel(total)} · ${fresh[0].label}` : `${xpLabel(total)} · ${fresh.length} rewards`);
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [xp]);

  if (!xp) return null;
  const t = toast && <div className="xp-toast" role="status" data-testid="xp-toast">{toast}</div>;
  if (toastOnly) return t || null;
  return (
    <>
      <Link href="/achievements" className="xp-chip" aria-label={`Level ${xp.level.level}. See missions`} data-testid="level-chip">
        <LevelRing info={xp.level} size={34} />
        <span className="xp-chip-txt">
          <b>Lv {xp.level.level}</b>
          <span>{xp.spendableXp.toLocaleString("en-US")} XP</span>
        </span>
      </Link>
      {t}
    </>
  );
}

"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import SimMode from "@/components/sim/SimMode";
import PaperCoin from "@/components/sim/PaperCoin";

/** /flight/sim — SIMULATOR game mode (free paper trading on a local market; no wallet, no transactions).
 *  ?difficulty=pve|pvp|trench  ?seed=N|text  ?speed=1|2|4  ?minutes=N  ?balance=N  ?tune=1  ?autostart=1
 *  ?view=coin — PAPER TRADING on the real coin screen (components/sim/PaperCoin): ?difficulty=easy|medium|hard ?bots=N ?dev=1 */
function Inner() {
  const sp = useSearchParams();
  if (sp.get("view") === "coin") return <PaperCoin initial={{ difficulty: sp.get("difficulty") || undefined, seed: sp.get("seed") || undefined, speed: +(sp.get("speed") || 0) || undefined,
    minutes: +(sp.get("minutes") || 0) || undefined, bots: sp.get("bots") != null ? +sp.get("bots")! : undefined, autostart: sp.get("autostart") === "1", dev: sp.get("dev") === "1" }} />;
  return <SimMode initial={{ difficulty: sp.get("difficulty") || undefined, seed: sp.get("seed") || undefined, tune: sp.get("tune") === "1", autostart: sp.get("autostart") === "1",
    speed: +(sp.get("speed") || 0) || undefined, minutes: +(sp.get("minutes") || 0) || undefined, balance: +(sp.get("balance") || 0) || undefined }} />;
}
export default function SimPage() {
  return <Suspense fallback={<div className="flex h-screen items-center justify-center text-[#ffe7a3]">Loading simulator…</div>}><Inner /></Suspense>;
}

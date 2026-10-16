"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import SimMode from "@/components/sim/SimMode";

/** /flight/sim — SIMULATOR game mode (free paper trading on a local market; no wallet, no transactions).
 *  ?difficulty=pve|pvp|trench  ?seed=N|text  ?speed=1|2|4  ?minutes=N  ?balance=N  ?tune=1  ?autostart=1 */
function Inner() {
  const sp = useSearchParams();
  return <SimMode initial={{ difficulty: sp.get("difficulty") || undefined, seed: sp.get("seed") || undefined, tune: sp.get("tune") === "1", autostart: sp.get("autostart") === "1",
    speed: +(sp.get("speed") || 0) || undefined, minutes: +(sp.get("minutes") || 0) || undefined, balance: +(sp.get("balance") || 0) || undefined }} />;
}
export default function SimPage() {
  return <Suspense fallback={<div className="flex h-screen items-center justify-center text-[#ffe7a3]">Loading simulator…</div>}><Inner /></Suspense>;
}

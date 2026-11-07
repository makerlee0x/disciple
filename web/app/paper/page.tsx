"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import PaperMode from "@/components/paper/PaperMode";

/** /paper — PAPER TRADING prototype (1 player vs 200 bots, simulated; no wallet, no transactions, no API calls).
 *  New, isolated route: nothing else links here yet. ?difficulty=easy|medium|hard  ?seed=N  ?speed=1|10|60  ?autostart=1
 *  ?endAt=SECONDS (test hook: End Session at that round time). Prototype UI only — SITE mocks the real front end. */
function Inner() {
  const sp = useSearchParams();
  return <PaperMode initial={{ difficulty: sp.get("difficulty") || undefined, seed: sp.get("seed") || undefined, speed: +(sp.get("speed") || 0) || undefined,
    autostart: sp.get("autostart") === "1", endAt: +(sp.get("endAt") || 0) || undefined }} />;
}
export default function PaperPage() {
  return <Suspense fallback={<div style={{ padding: 40, color: "#ffe7a3" }}>Loading paper trading…</div>}><Inner /></Suspense>;
}

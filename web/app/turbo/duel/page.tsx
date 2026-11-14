"use client";
/**
 * /turbo/duel: Trading Duel (hidden with the rest of Turbo: /turbo?turbo=1 on this device, and the Turbo password).
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { isTurboEnabled } from "@/lib/turbo/flag";

const DuelScreen = dynamic(() => import("@/components/turbo/duel/DuelScreen"), { ssr: false });

export default function DuelPage() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { setOn(isTurboEnabled()); }, []);
  if (!on) return null;
  return <DuelScreen />;
}

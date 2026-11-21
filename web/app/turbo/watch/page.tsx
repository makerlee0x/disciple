"use client";
/**
 * /turbo/watch: spectate live Trading Duels (components/turbo/watch/WatchScreen). Hidden with the rest of Turbo.
 */
import { Suspense, useEffect, useState } from "react";
import { isTurboEnabled } from "@/lib/turbo/flag";
import WatchScreen from "@/components/turbo/watch/WatchScreen";

export default function WatchPage() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { setOn(isTurboEnabled()); }, []);
  if (!on) return null;
  return <Suspense fallback={null}><WatchScreen /></Suspense>;
}

"use client";
/**
 * /turbo — DISCIPLE Turbo (live front end; Nova adapter plugs in at lib/turbo getTurboAdapter()).
 * Hidden: renders nothing until isTurboEnabled() says yes on the client (visit /turbo?turbo=1 once on this device;
 * /turbo?turbo=0 turns it off). Server render and first paint are empty, so nothing leaks without the flag.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { isTurboEnabled } from "@/lib/turbo/flag";

const TurboScreen = dynamic(() => import("@/components/turbo/TurboScreen"), { ssr: false });

export default function TurboPage() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { setOn(isTurboEnabled()); }, []);
  if (!on) return null;
  return <TurboScreen />;
}

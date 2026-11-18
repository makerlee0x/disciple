"use client";
/**
 * /turbo/climb: Climb, the solo Turbo mode (hidden with the rest of Turbo behind the Turbo flag). Play money for now.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { isTurboEnabled } from "@/lib/turbo/flag";

const ClimbScreen = dynamic(() => import("@/components/turbo/climb/ClimbScreen"), { ssr: false });

export default function ClimbPage() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { setOn(isTurboEnabled()); }, []);
  if (!on) return null;
  return <ClimbScreen />;
}

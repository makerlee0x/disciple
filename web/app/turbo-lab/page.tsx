"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { isTurboEnabled } from "@/lib/turbo";

const TurboScreen = dynamic(() => import("@/components/turbo/TurboScreen"), { ssr: false });

/** /turbo-lab — hidden (not linked, noindex). Gated by SITE's flag: NEXT_PUBLIC_TURBO=1 or one visit with ?turbo=1. */
export default function TurboLabPage() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { setOn(isTurboEnabled()); }, []);
  if (on === null) return null;
  if (!on) return <div className="flex h-screen items-center justify-center text-sm opacity-60">Not found</div>;
  return <TurboScreen />;
}

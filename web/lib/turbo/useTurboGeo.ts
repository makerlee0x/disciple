"use client";
import { useEffect, useState } from "react";
import { checkTurboGeo, type TurboGeo } from "./geo";

/** { loading, ...TurboGeo }. Stub: always allowed (see geo.ts TODO). */
export function useTurboGeo(): TurboGeo & { loading: boolean } {
  const [geo, setGeo] = useState<TurboGeo | null>(null);
  useEffect(() => {
    let live = true;
    checkTurboGeo().then((g) => { if (live) setGeo(g); }).catch(() => { if (live) setGeo({ allowed: false, country: null, reason: "Turbo isn't available right now.", source: "mock" }); });
    return () => { live = false; };
  }, []);
  return geo ? { ...geo, loading: false } : { allowed: false, country: null, source: "mock", loading: true };
}

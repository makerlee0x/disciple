"use client";
import { useCallback, useEffect, useState } from "react";
import { getTurboAdapter } from "./index";

/**
 * Turbo fuel ($) from the active adapter. Separate from game cash. Practice adapter: stored in localStorage
 * "disciple.turbo.fuel.v1". `practice` is true while the mock is active — label the balance as practice then.
 */
export function useTurboFuel() {
  const [usd, setUsd] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = getTurboAdapter();

  useEffect(() => {
    let live = true;
    a.getFuel().then((f) => { if (live) setUsd(f.usd); }).catch(() => {});
    const off = a.onFuel((f) => setUsd(f.usd));
    return () => { live = false; off(); };
  }, [a]);

  const run = useCallback(async (fn: (() => Promise<{ usd: number }>) | undefined) => {
    if (!fn) { setError("Not available yet"); return false; }
    setBusy(true); setError(null);
    try { setUsd((await fn()).usd); return true; } catch (e) { setError(e instanceof Error ? e.message : "That didn't go through. Try again."); return false; } finally { setBusy(false); }
  }, []);

  const addFuel = useCallback((n: number) => run(a.addFuel ? () => a.addFuel!(n) : undefined), [a, run]);
  const withdrawFuel = useCallback((n: number) => run(a.withdrawFuel ? () => a.withdrawFuel!(n) : undefined), [a, run]);

  return { usd, loading: usd === null, busy, error, addFuel, withdrawFuel, practice: a.kind === "practice" };
}

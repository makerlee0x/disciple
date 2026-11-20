"use client";
/**
 * Privy = auth + embedded EOA custody only (owner of the user's Alchemy MAv2, lib/aa/session.ts).
 * @privy-io/react-auth is lazy-loaded into its own chunk (PrivyMount) so it is NOT in any page's first-load JS,
 * and is never fetched when Privy is off (no app id / NEXT_PUBLIC_AA_SIGNER=local). Children render immediately;
 * the login modal portals itself, and WalletButton reaches it through registerPrivy()/privyLogin().
 */
import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import { isCoinPath } from "@/lib/coinPath";
import { hasSavedSession } from "@/lib/aa/sessionState";
import { PRIVY_APP_ID, SIGNER_MODE } from "@/lib/aa/env"; // not lib/aa/session: that would put viem + noble in every page's first-load JS

const PrivyMount = dynamic(() => import("./PrivyMount"), { ssr: false });

/** On a coin page Privy (~2 MB of JS with WalletConnect / Coinbase / on-ramp code) waits until the rocket is flying, so it
 *  doesn't fight the flight engine for the main thread (maker 2026-11-20: "it needs to be under a second"). It starts on
 *  the first tap or key, the engine's first price + idle, or 4 s, whichever comes first. The signed-in pill paints from
 *  its cache meanwhile (WalletButton lastPill). A signed-in browser waits at most 1.5 s, so its wallet is ready to trade.
 *  Every other page mounts it right away, as before. */
export const PRIVY_DEFER_MAX_MS = 4000, PRIVY_DEFER_SIGNED_IN_MS = 1500;
function useDeferOnCoinPage(): boolean {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!isCoinPath(location.pathname)) { setGo(true); return; }
    let done = false, idleId: number | undefined;
    const start = () => { if (done) return; done = true; cleanup(); setGo(true); };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const onMark = () => { idleId = w.requestIdleCallback ? w.requestIdleCallback(start, { timeout: 1200 }) : window.setTimeout(start, 300); };
    const t = window.setTimeout(start, hasSavedSession() ? PRIVY_DEFER_SIGNED_IN_MS : PRIVY_DEFER_MAX_MS);
    function cleanup() {
      clearTimeout(t);
      removeEventListener("disciple:mark", onMark);
      removeEventListener("pointerdown", start, true);
      removeEventListener("keydown", start, true);
    }
    addEventListener("disciple:mark", onMark, { once: true });
    addEventListener("pointerdown", start, true);
    addEventListener("keydown", start, true);
    return () => { cleanup(); void idleId; };
  }, []);
  return go;
}

export default function PrivyProviders({ children }: { children: ReactNode }) {
  const go = useDeferOnCoinPage();
  return (
    <>
      {children}
      {go && PRIVY_APP_ID && SIGNER_MODE === "privy" ? <PrivyMount /> : null}
    </>
  );
}

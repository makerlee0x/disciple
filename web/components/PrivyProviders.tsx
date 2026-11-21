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
import { PRIVY_WANTED_EVENT, hasSavedSession } from "@/lib/aa/sessionState";
import { PRIVY_APP_ID, SIGNER_MODE } from "@/lib/aa/env"; // not lib/aa/session: that would put viem + noble in every page's first-load JS

const PrivyMount = dynamic(() => import("./PrivyMount"), { ssr: false });

/** On a coin page Privy (~2 MB of JS with WalletConnect / Coinbase / on-ramp code) waits until the rocket is flying, so it
 *  doesn't fight the flight engine for the main thread (maker 2026-11-20: "it needs to be under a second"). It starts on
 *  the first tap or key, the engine's first price + idle, or 4 s, whichever comes first. The signed-in pill paints from
 *  its cache meanwhile (WalletButton lastPill). A signed-in browser waits at most 1.5 s, so its wallet is ready to trade.
 *  Every other page (speed pass 2026-11-21): a browser with a saved session mounts it right away, as before; a signed-out
 *  visitor gets it once the page has loaded and gone idle (its images and art come first), on the first tap or key, or
 *  when something asks for it (PRIVY_WANTED_EVENT: a Sign in tap opens the window once it's ready). */
export const PRIVY_DEFER_MAX_MS = 4000, PRIVY_DEFER_SIGNED_IN_MS = 1500, PRIVY_DEFER_PAGE_MAX_MS = 5000;
function useDeferPrivy(): boolean {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const coin = isCoinPath(location.pathname);
    const signedIn = hasSavedSession();
    if (!coin && signedIn) { setGo(true); return; }
    let done = false, idleId: number | undefined;
    const start = () => { if (done) return; done = true; cleanup(); setGo(true); };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const idle = () => { idleId = w.requestIdleCallback ? w.requestIdleCallback(start, { timeout: 1200 }) : window.setTimeout(start, 300); };
    const t = window.setTimeout(start, coin ? (signedIn ? PRIVY_DEFER_SIGNED_IN_MS : PRIVY_DEFER_MAX_MS) : PRIVY_DEFER_PAGE_MAX_MS);
    // coin page: the engine's first price; other pages: the window load event (already past on a client-side navigation)
    const onLoad = () => idle();
    function cleanup() {
      clearTimeout(t);
      removeEventListener("disciple:mark", idle);
      removeEventListener("load", onLoad);
      removeEventListener("pointerdown", start, true);
      removeEventListener("keydown", start, true);
      removeEventListener(PRIVY_WANTED_EVENT, start);
    }
    if (coin) addEventListener("disciple:mark", idle, { once: true });
    else if (document.readyState === "complete") idle();
    else addEventListener("load", onLoad, { once: true });
    addEventListener("pointerdown", start, true);
    addEventListener("keydown", start, true);
    addEventListener(PRIVY_WANTED_EVENT, start);
    return () => { cleanup(); void idleId; };
  }, []);
  return go;
}

export default function PrivyProviders({ children }: { children: ReactNode }) {
  const go = useDeferPrivy();
  return (
    <>
      {children}
      {go && PRIVY_APP_ID && SIGNER_MODE === "privy" ? <PrivyMount /> : null}
    </>
  );
}

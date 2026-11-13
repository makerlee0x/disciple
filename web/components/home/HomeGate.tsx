"use client";
/**
 * The home's two lobbies: signed-in players get the regular lobby, signed-out visitors the landing lobby
 * (LobbySignedOut). Both are server-rendered; a tiny inline script picks one before first paint from the saved
 * session (lib/aa/session, localStorage), so a returning player never sees the landing page flash. After mount the
 * live sign-in state decides (Privy, the smart session, the wallet pill) and the other lobby is unmounted.
 */
import { useEffect, useState, type ReactNode } from "react";
import { aaSession, hasSavedSession, onPrivy, onSessionChange, privyAuthenticated, privyLoaded } from "@/lib/aa/session";
import { WALLET_ID_EVENT, walletId } from "@/lib/walletCta";
import s from "./homeGate.module.css";

type Auth = "in" | "out";
/** lib/aa/session's saved session key (kept in step by hand: this runs before any bundle loads). */
const SESSION_LS = "disciple.aa.session.v2";
const GUESS_JS = `(function(){try{var e=document.currentScript.parentNode,v=JSON.parse(localStorage.getItem("${SESSION_LS}")||"null");if(v&&v.owner&&(!v.expiresAt||v.expiresAt>Date.now()))e.setAttribute("data-auth","in")}catch(_){}})()`;
/** Privy never reports (no app id, blocked script): stop waiting and treat the visitor as signed out. */
const GIVE_UP_MS = 6_000;

export default function HomeGate({ signedIn, signedOut }: { signedIn: ReactNode; signedOut: ReactNode }) {
  const [auth, setAuth] = useState<Auth>("out");
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setAuth(hasSavedSession() ? "in" : "out");
    const sync = () => {
      const live = privyAuthenticated() || !!aaSession() || !!walletId()?.address;
      if (live) { setAuth("in"); setSettled(true); }
      else if (privyLoaded()) { setAuth("out"); setSettled(true); }
    };
    sync();
    const giveUp = setTimeout(() => { if (!(privyAuthenticated() || aaSession() || walletId()?.address)) setAuth("out"); setSettled(true); }, GIVE_UP_MS);
    const a = onPrivy(sync), b = onSessionChange(sync);
    addEventListener(WALLET_ID_EVENT, sync);
    return () => { clearTimeout(giveUp); a(); b(); removeEventListener(WALLET_ID_EVENT, sync); };
  }, []);
  // until the live state is known keep both mounted (CSS shows the guessed one); then only the right one
  return (
    <div className={s.gate} data-auth={auth} suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: GUESS_JS }} />
      {(!settled || auth === "in") && <div className={s.in}>{signedIn}</div>}
      {(!settled || auth === "out") && <div className={s.out}>{signedOut}</div>}
    </div>
  );
}

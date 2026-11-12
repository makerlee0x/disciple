"use client";
import { useEffect } from "react";
import { captureRefFromCookie, captureRefFromQuery } from "@/lib/referral";
/** Mirrors the /r/<name> first-touch cookie into localStorage so trade calls can read the referrer; a coin share link's
 *  ?ref=<0xwallet> counts as a first touch too (cookie first, so an earlier /r/ touch still wins).
 *  Once signed in, lib/referralBindClient (own chunk, fails silently) saves that first touch to the account. */
export default function RefCapture() {
  useEffect(() => {
    captureRefFromCookie(); captureRefFromQuery(window.location.search);
    let off: (() => void) | null = null, gone = false;
    import("@/lib/referralBindClient").then((m) => { if (!gone) off = m.startRefBind(); }).catch(() => {});
    return () => { gone = true; off?.(); };
  }, []);
  return null;
}

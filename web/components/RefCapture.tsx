"use client";
import { useEffect } from "react";
import { trackFunnel } from "@/lib/funnelClient";
import { captureRefFromCookie, captureRefFromQuery, captureRefUsernameFromQuery } from "@/lib/referral";
/** Mirrors the /r/<name> first-touch cookie into localStorage so trade calls can read the referrer; a coin share link's
 *  ?ref=<0xwallet> counts as a first touch too (cookie first, so an earlier /r/ touch still wins). A captured touch counts
 *  the ref_land funnel step once per browser. */
export default function RefCapture() {
  useEffect(() => {
    const got = () => trackFunnel("ref_land");
    if (captureRefFromCookie() || captureRefFromQuery(window.location.search)) { got(); return; }
    void captureRefUsernameFromQuery(window.location.search).then((t) => { if (t) got(); }).catch(() => {});
  }, []);
  return null;
}

"use client";
import { useEffect } from "react";
import { captureRefFromCookie, captureRefFromQuery } from "@/lib/referral";
/** Mirrors the /r/<name> first-touch cookie into localStorage so trade calls can read the referrer; a coin share link's
 *  ?ref=<0xwallet> counts as a first touch too (cookie first, so an earlier /r/ touch still wins). */
export default function RefCapture() {
  useEffect(() => { captureRefFromCookie(); captureRefFromQuery(window.location.search); }, []);
  return null;
}

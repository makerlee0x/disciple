"use client";
import { useEffect } from "react";
import { captureRefFromCookie, captureRefFromQuery, captureRefUsernameFromQuery } from "@/lib/referral";
/** Mirrors the /r/<name> first-touch cookie into localStorage so trade calls can read the referrer; a coin share link's
 *  ?ref=<0xwallet> counts as a first touch too (cookie first, so an earlier /r/ touch still wins). */
export default function RefCapture() {
  useEffect(() => { captureRefFromCookie(); if (!captureRefFromQuery(window.location.search)) void captureRefUsernameFromQuery(window.location.search); }, []);
  return null;
}

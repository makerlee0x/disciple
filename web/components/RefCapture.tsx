"use client";
import { useEffect } from "react";
import { captureRefFromCookie } from "@/lib/referral";
/** Mirrors the /r/<name> first-touch cookie into localStorage so trade calls can read the referrer. */
export default function RefCapture() {
  useEffect(() => { captureRefFromCookie(); }, []);
  return null;
}

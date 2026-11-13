"use client";

import Link from "next/link";
import { useEffect } from "react";
import LostSky, { LostWarn } from "@/components/LostSky";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // the raw message (may carry ids / hex / internals) goes to the console, never onto the page
  useEffect(() => { console.warn("[disciple] page error", { message: error.message?.slice(0, 300), digest: error.digest }); }, [error]);
  return (
    <LostSky art={<LostWarn />} eyebrow="Engine trouble" tone="pink" title="This page didn't load" body="Try again. If it keeps happening, head back to the Lobby." testId="page-error">
      <button type="button" className="r2-gold ls-gold" onClick={reset}>Try again</button>
      <Link href="/" className="r2-btn ls-btn">Lobby</Link>
    </LostSky>
  );
}

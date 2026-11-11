"use client";

import Link from "next/link";
import { useEffect } from "react";
import LostSky from "@/components/LostSky";
import Icon from "@/components/icons/Icon";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // the raw message (may carry ids / hex / internals) goes to the console, never onto the page
  useEffect(() => { console.warn("[disciple] page error", { message: error.message?.slice(0, 300), digest: error.digest }); }, [error]);
  return (
    <LostSky
      kicker={<Icon name="warning" size={28} />}
      title="Something went wrong on this page."
      body="Try again. If it keeps happening, head back to the launchpad."
    >
      <button type="button" className="ds-btn gold" onClick={reset}>Try again</button>
      <Link href="/" className="ds-btn">Launchpad</Link>
    </LostSky>
  );
}

"use client";

import Link from "next/link";
import { useEffect } from "react";
import Icon from "@/components/icons/Icon";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // the raw message (may carry ids / hex / internals) goes to the console, never onto the page
  useEffect(() => { console.warn("[disciple] page error", { message: error.message?.slice(0, 300), digest: error.digest }); }, [error]);
  return (
    <div className="ds-lost">
      <div>
        <h1><Icon name="warning" size={48} label="Error" /></h1>
        <h2>Turbulence</h2>
        <p>Something went wrong on this page.</p>
        <div className="actions">
          <button type="button" className="ds-btn gold" onClick={reset}>Try again</button>
          <Link href="/" className="ds-btn">Launchpad</Link>
        </div>
      </div>
    </div>
  );
}

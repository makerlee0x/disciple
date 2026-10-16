"use client";

import Link from "next/link";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="ds-lost">
      <div>
        <h1>⚠</h1>
        <h2>Turbulence</h2>
        <p>Something went wrong on this page. {error.message ? <span className="mono tiny">({error.message.slice(0, 140)})</span> : null}</p>
        <div className="actions">
          <button type="button" className="ds-btn gold" onClick={reset}>Try again</button>
          <Link href="/" className="ds-btn">Launchpad</Link>
        </div>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { withBase } from "@/lib/base-path";

/**
 * Lost-page shell (404 and the page error boundary).
 * Pattern: a short status, one sentence about what happened, and a way back
 * (the usual lost-page layout). Skinned with the flight sky and rocket already in public/assets.
 */
export default function LostSky({
  kicker,
  title,
  body,
  children,
  testId,
}: {
  kicker: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="ds-lost" aria-labelledby="ds-lost-title" data-testid={testId}>
      <div className="ds-lost-sky" aria-hidden="true">
        {/* withBase prefixes the static preview; next/image would rewrite that path. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/assets/tier1.webp")} alt="" />
      </div>
      <div className="ds-lost-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ds-lost-rocket" src={withBase("/assets/rocket.png")} alt="" width={64} height={160} />
        <p className="ds-lost-kicker">{kicker}</p>
        <h1 id="ds-lost-title">{title}</h1>
        <p className="ds-lost-body">{body}</p>
        <div className="actions">{children}</div>
      </div>
    </section>
  );
}

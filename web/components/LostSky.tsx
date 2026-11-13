import type { ReactNode } from "react";
import { withBase } from "@/lib/base-path";

/**
 * Lost-page shell for the 404 and the page error boundary (step 7 board "Link previews, 404 and invites", maker
 * 2026-11-13): the lobby sky behind one centred card, under the normal top bar. The card holds a short eyebrow, a
 * Barlow headline, one line about what happened, and a way back.
 */
export default function LostSky({
  art,
  eyebrow,
  tone = "blue",
  title,
  body,
  children,
  testId,
}: {
  art: ReactNode;
  eyebrow: string;
  tone?: "blue" | "pink";
  title: string;
  body: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="ls-page" aria-labelledby="ls-title" data-testid={testId}>
      <div className="ls-sky" aria-hidden="true">
        {/* withBase prefixes the static preview; next/image would rewrite that path. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase("/home/sky/t6.webp")} alt="" />
      </div>
      <div className="ls-card">
        {art}
        <span className={`r2-eb ls-eb${tone === "pink" ? " pink" : ""}`}>{eyebrow}</span>
        <h1 id="ls-title" className="r2-g">{title}</h1>
        <p>{body}</p>
        <div className="ls-acts">{children}</div>
      </div>
    </section>
  );
}

/** The chrome rocket drifting sideways, off course (404). */
export function LostRocket() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="ls-rocket" src={withBase("/assets/rocket-hi.webp")} alt="" />;
}

/** The pink warning ring (page error). */
export function LostWarn() {
  return (
    <span className="ls-warn" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></svg>
    </span>
  );
}

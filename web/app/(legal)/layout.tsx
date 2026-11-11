/**
 * Shared chrome for /terms, /privacy, and /risk. Same docs skin as /security (app/docs/docs.css):
 * Instrument Serif headings, Geist body, --dsc-* tokens. The banner is the draft warning.
 */
import type { ReactNode } from "react";
import "../docs/docs.css";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="dv-root" data-testid="legal-page">
      <div className="dv-banner dv-banner-legal" role="note">
        <span className="dv-banner-tag">Draft</span>
        <span className="dv-banner-txt">No lawyer has read this. This is a draft in plain words, and it is not legal advice.</span>
      </div>
      {children}
    </div>
  );
}

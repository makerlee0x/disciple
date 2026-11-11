/**
 * Shared chrome for /terms, /privacy, and /risk. Same docs skin as /security (app/docs/docs.css):
 * Instrument Serif headings, Geist body, --dsc-* tokens.
 */
import type { ReactNode } from "react";
import "../docs/docs.css";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="dv-root" data-testid="legal-page">
      {children}
    </div>
  );
}

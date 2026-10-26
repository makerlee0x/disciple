/**
 * /security: how to report a bug, scope, response times, safe harbor and rewards (TBD by lee).
 * Static server page, no API calls. Copy: content/security.md (BRAND draft r1, pending lee). Docs styling (app/docs).
 * While any "To be confirmed" item is left the page is noindex, so a half-filled policy isn't indexed.
 */
import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { securityPage } from "@/lib/security/content";
import "../docs/docs.css";

export function generateMetadata(): Metadata {
  const p = securityPage();
  return {
    title: "Security · DISCIPLE",
    description: "Found a bug? Tell us first. How to report a security issue to DISCIPLE.",
    ...(p.pending ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function SecurityPage() {
  const page = securityPage();
  return (
    <div className="dv-root" data-testid="security-page">
      {page.pending > 0 && (
        <div className="dv-banner" role="note">
          <span className="dv-banner-tag">Draft</span>
          <span className="dv-banner-txt">Some details are still being decided.<span className="dv-banner-more"> They&apos;re marked &quot;To be confirmed&quot;.</span></span>
        </div>
      )}
      <DocsArticle page={page} prev={null} next={null} />
    </div>
  );
}

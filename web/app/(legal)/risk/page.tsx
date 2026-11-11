import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export function generateMetadata(): Metadata {
  const { page } = legalView("risk");
  return {
    title: "Risk · DISCIPLE",
    description: "Read this before you trade on DISCIPLE. No lawyer has read this.",
    ...(page.pending ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function RiskPage() {
  const { page, prev, next } = legalView("risk");
  return (
    <div data-testid="legal-risk">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

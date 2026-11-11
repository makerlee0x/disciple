import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export function generateMetadata(): Metadata {
  const { page } = legalView("terms");
  return {
    title: "Terms of Use · DISCIPLE",
    description: "The rules for using DISCIPLE. No lawyer has read this.",
    ...(page.pending ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function TermsPage() {
  const { page, prev, next } = legalView("terms");
  return (
    <div data-testid="legal-terms">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

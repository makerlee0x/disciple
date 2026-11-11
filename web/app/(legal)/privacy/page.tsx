import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export function generateMetadata(): Metadata {
  const { page } = legalView("privacy");
  return {
    title: "Privacy Policy · DISCIPLE",
    description: "What DISCIPLE can see about you. No lawyer has read this.",
    ...(page.pending ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function PrivacyPage() {
  const { page, prev, next } = legalView("privacy");
  return (
    <div data-testid="legal-privacy">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

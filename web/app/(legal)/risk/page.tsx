import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export const metadata: Metadata = {
  title: "Risk · DISCIPLE",
  description: "Read this before you trade on DISCIPLE. You can lose everything you put in.",
};

export default function RiskPage() {
  const { page, prev, next } = legalView("risk");
  return (
    <div data-testid="legal-risk">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

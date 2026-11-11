import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export const metadata: Metadata = {
  title: "Terms of Use · DISCIPLE",
  description: "The rules for using DISCIPLE. You use it at your own risk.",
};

export default function TermsPage() {
  const { page, prev, next } = legalView("terms");
  return (
    <div data-testid="legal-terms">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

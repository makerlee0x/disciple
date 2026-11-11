import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export const metadata: Metadata = {
  title: "Privacy Policy · DISCIPLE",
  description: "What DISCIPLE can see about you when you sign in and trade.",
};

export default function PrivacyPage() {
  const { page, prev, next } = legalView("privacy");
  return (
    <div data-testid="legal-privacy">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

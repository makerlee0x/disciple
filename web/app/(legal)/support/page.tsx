import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { legalView } from "@/lib/legal/content";

export const metadata: Metadata = {
  title: "Support · DISCIPLE",
  description: "Contact the DISCIPLE Team: hello@disciple.vip.",
};

export default function SupportPage() {
  const { page, prev, next } = legalView("support");
  return (
    <div data-testid="legal-support">
      <DocsArticle page={page} prev={prev} next={next} />
    </div>
  );
}

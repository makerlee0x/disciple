/**
 * /docs: docs v1 (BRAND, Oct 17 2026). Indexable since the mainnet deploy (2026-11-20).
 * Content: web/content/docs/v1 (copied from disciple-brand/docs/v1/pages). Rendering: lib/docs/content.ts (build time).
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import DocsShell from "@/components/docs/DocsShell";
import { docSections } from "@/lib/docs/content";
import "./docs.css";

export const metadata: Metadata = {
  title: { default: "Docs · DISCIPLE", template: "%s · DISCIPLE Docs" },
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  const sections = docSections().map((s) => ({ title: s.title, pages: s.pages.map((p) => ({ title: p.title, slug: p.slug })) }));
  return <DocsShell sections={sections}>{children}</DocsShell>;
}

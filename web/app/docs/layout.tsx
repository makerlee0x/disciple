/**
 * /docs: TEMPORARY docs v1 draft (BRAND, Oct 17 2026). noindex while it's a draft; no nav link points here yet.
 * Content: web/content/docs/v1 (copied from disciple-brand/docs/v1/pages). Rendering: lib/docs/content.ts (build time).
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import DocsShell from "@/components/docs/DocsShell";
import { docSections } from "@/lib/docs/content";
import "./docs.css";

export const metadata: Metadata = {
  title: { default: "Docs (draft) · DISCIPLE", template: "%s · DISCIPLE Docs (draft)" },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  const sections = docSections().map((s) => ({ title: s.title, pages: s.pages.map((p) => ({ title: p.title, slug: p.slug })) }));
  return <DocsShell sections={sections}>{children}</DocsShell>;
}

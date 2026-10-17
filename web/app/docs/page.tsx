import type { Metadata } from "next";
import DocsArticle from "@/components/docs/DocsArticle";
import { allDocs, docSections, renderDoc } from "@/lib/docs/content";

export const metadata: Metadata = { title: { absolute: "Docs (draft) · DISCIPLE" } };

export default function DocsIndex() {
  const docs = allDocs();
  const i = docs.findIndex((d) => d.slug === "/docs");
  if (i < 0) throw new Error("docs: no page with slug /docs");
  return <DocsArticle page={renderDoc(docs[i])} prev={null} next={docs[i + 1] ?? null} sections={docSections()} />;
}

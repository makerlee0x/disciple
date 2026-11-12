import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DocsArticle from "@/components/docs/DocsArticle";
import { allDocs, findDoc, renderDoc, slugParts } from "@/lib/docs/content";

export const dynamicParams = false;

export function generateStaticParams() {
  return allDocs().filter((d) => d.slug !== "/docs").map((d) => ({ slug: slugParts(d.slug) }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const d = findDoc(slug);
  return d ? { title: d.title } : {};
}

export default async function DocPageRoute({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const d = findDoc(slug);
  if (!d) notFound();
  const docs = allDocs();
  const i = docs.findIndex((x) => x.slug === d.slug);
  return <DocsArticle page={renderDoc(d)} prev={docs[i - 1] ?? null} next={docs[i + 1] ?? null} />;
}

import type { Metadata } from "next";
import StatsPage from "@/components/stats/StatsPage";

export const dynamic = "force-dynamic";

/** The static preview build needs one pre-rendered path (see /u/[username]). */
export function generateStaticParams() {
  return process.env.STATIC_PREVIEW === "1" ? [{ username: "pilot" }] : [];
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${decodeURIComponent(username).replace(/^@/, "")} stats · DISCIPLE` };
}

export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <StatsPage username={decodeURIComponent(username)} />;
}

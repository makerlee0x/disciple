import type { Metadata } from "next";
import TurboPage from "@/components/turbo/page/TurboPage";

export const dynamic = "force-dynamic";

/** The static preview build needs one pre-rendered path (see /u/[username]). */
export function generateStaticParams() {
  return process.env.STATIC_PREVIEW === "1" ? [{ username: "pilot" }] : [];
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${decodeURIComponent(username).replace(/^@/, "")} Turbo · DISCIPLE` };
}

/** A pilot's public Turbo page: record, recent duels, real trades and PnL (no balance). */
export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <TurboPage username={decodeURIComponent(username)} />;
}

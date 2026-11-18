import type { Metadata } from "next";
export const metadata: Metadata = { title: "Lighter test · DISCIPLE", robots: { index: false, follow: false } };
export default function LighterLayout({ children }: { children: React.ReactNode }) { return children; }

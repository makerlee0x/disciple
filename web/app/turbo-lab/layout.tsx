import type { Metadata } from "next";

/** /turbo-lab: hidden GAME lab for TURBO (mock prices, practice fuel). Not linked anywhere; noindex. */
export const metadata: Metadata = {
  title: "Turbo lab · DISCIPLE",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};
export default function TurboLabLayout({ children }: { children: React.ReactNode }) { return children; }

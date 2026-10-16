import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { Anton } from "next/font/google";

/** Heavy condensed display face for the WITH matchup cards. */
const vsFont = Anton({ weight: "400", subsets: ["latin"], variable: "--font-vs", display: "swap" });

export const metadata: Metadata = {
  title: "DISCIPLE — Every coin is a rocket",
  description:
    "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude = price. Robinhood Chain.",
  metadataBase: new URL("https://disciple.vip"),
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={vsFont.variable}>
      <body className="antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

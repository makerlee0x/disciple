import type { Metadata, Viewport } from "next";
import "./brand-tokens.css";
import "./globals.css";
import { geist, instrumentSerif } from "./fonts";
import AppShell from "@/components/AppShell";
import ChatBridge from "@/components/chat/ChatBridge";

export const metadata: Metadata = {
  title: "DISCIPLE — Every coin is a rocket",
  description:
    "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude = price. Robinhood Chain.",
  metadataBase: new URL("https://disciple.vip"),
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "DISCIPLE — Every coin is a rocket",
    description:
      "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude = price. Robinhood Chain.",
    url: "/",
    siteName: "DISCIPLE",
    type: "website",
    images: [{ url: "/brand/og-1200x630.png", width: 1200, height: 630, alt: "DISCIPLE" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DISCIPLE — Every coin is a rocket",
    description:
      "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude = price. Robinhood Chain.",
    images: ["/brand/og-1200x630.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0C0E",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable}`}>
      <body className="antialiased">
        <AppShell>{children}</AppShell>
        <ChatBridge />
      </body>
    </html>
  );
}

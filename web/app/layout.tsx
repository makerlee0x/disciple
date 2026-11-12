import type { Metadata, Viewport } from "next";
import "./brand-tokens.css";
import "./brand-tokens-v2.css";
import "./globals.css";
import "./claims.css";
import { geist, instrumentSerif } from "./fonts";
import AppShell from "@/components/AppShell";
import ChatBridge from "@/components/chat/ChatBridge";
import PrivyProviders from "@/components/PrivyProviders";
import IconSprite from "@/components/icons/IconSprite";
import { sponsorshipConfig } from "@/lib/server/sponsorshipConfig";
import { SPONSORSHIP_CONFIG_ID } from "@/lib/aa/sponsorshipMode";

export const metadata: Metadata = {
  title: "DISCIPLE — Every coin is a rocket",
  description:
    "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude is how high a rocket's value has climbed, shown as named tiers. Robinhood Chain.",
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
      "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude is how high a rocket's value has climbed, shown as named tiers. Robinhood Chain.",
    url: "/",
    siteName: "DISCIPLE",
    type: "website",
    images: [{ url: "/brand/og-1200x630.png", width: 1200, height: 630, alt: "DISCIPLE" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DISCIPLE — Every coin is a rocket",
    description:
      "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude is how high a rocket's value has climbed, shown as named tiers. Robinhood Chain.",
    images: ["/brand/og-1200x630.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0C0E",
  width: "device-width",
  initialScale: 1,
  // Notch / home-indicator inset for iOS Safari + in-wallet browsers (MetaMask, Rainbow, Coinbase).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable}`}>
      <body className="antialiased">
        <script id={SPONSORSHIP_CONFIG_ID} type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify(sponsorshipConfig()) }} />
        <IconSprite />
        <PrivyProviders>
          <AppShell>{children}</AppShell>
          <ChatBridge />
        </PrivyProviders>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import "./brand-tokens.css";
import "./brand-tokens-v2.css";
import "./brand-tokens-v3.css";
import "./xp-v3.css";
import "./globals.css";
import "./menu-v3.css";
import "./claims.css";
import "./profile-r5.css";
import "./hangar-v3.css";
import "./refresh-r2.css";
import { barlowCondensed, geist, instrumentSerif } from "./fonts";
import AppShell from "@/components/AppShell";
import ChatBridge from "@/components/chat/ChatBridge";
import PrivyProviders from "@/components/PrivyProviders";
import IconSprite from "@/components/icons/IconSprite";
import { sponsorshipConfig } from "@/lib/server/sponsorshipConfig";
import { SPONSORSHIP_CONFIG_ID } from "@/lib/aa/sponsorshipMode";

const SITE_TITLE = "DISCIPLE · Ride it to orbit";
const SITE_LINE = "Every rocket is a live match. The crew boosts it up, and anyone can bomb it down.";
/** Site card (step 7): drawn by /api/og/site (lib/server/og/card.ts). Rocket, pilot and invite pages carry their own. */
const SITE_CARD = { url: "/api/og/site", width: 1200, height: 630, alt: "DISCIPLE: Ride it to orbit" };

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_LINE,
  metadataBase: new URL("https://disciple.vip"),
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  // Add to Home Screen on iPhone (maker, 2026-11-14): open full screen with a dark status bar; web push needs this mode
  appleWebApp: { capable: true, title: "DISCIPLE", statusBarStyle: "black-translucent" },
  openGraph: { title: SITE_TITLE, description: SITE_LINE, url: "/", siteName: "DISCIPLE", type: "website", images: [SITE_CARD] },
  twitter: { card: "summary_large_image", site: "@disciplevip", title: SITE_TITLE, description: SITE_LINE, images: [SITE_CARD.url] },
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
    <html lang="en" className={`${geist.variable} ${instrumentSerif.variable} ${barlowCondensed.variable}`}>
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

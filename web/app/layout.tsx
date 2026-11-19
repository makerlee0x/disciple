import type { Metadata, Viewport } from "next";
import IosZoomLock from "@/components/app/IosZoomLock";
import "./brand-tokens.css";
import "./brand-tokens-v2.css";
import "./brand-tokens-v3.css";
import "./xp-v3.css";
import "./globals.css";
import "./menu-v3.css";
import "./claims.css";
import "./profile-r5.css";
import "./hangar-v3.css";
import "./hangar-profile.css";
import "./market.css";
import "./nft.css";
import "./refresh-r2.css";
import "./search.css";
import { barlowCondensed, geist, instrumentSerif } from "./fonts";
import AppShell from "@/components/AppShell";
import ChatBridge from "@/components/chat/ChatBridge";
import AppSounds from "@/components/AppSounds";
import LevelUpFlash from "@/components/xp/LevelUpFlash";
import PrivyProviders from "@/components/PrivyProviders";
import IconSprite from "@/components/icons/IconSprite";
import { sponsorshipConfig } from "@/lib/server/sponsorshipConfig";
import { SPONSORSHIP_CONFIG_ID } from "@/lib/aa/sponsorshipMode";

const GAME_ROUTE_JS = `(function(){try{var b=${JSON.stringify(process.env.NEXT_PUBLIC_BASE_PATH || "")},p=location.pathname;if(b&&p.indexOf(b)===0)p=p.slice(b.length)||"/";if(/^\\/(coin\\/|flight|turbo(\\/|$))/.test(p))document.body.classList.add("game")}catch(e){}})()`;

/** The iPhone app (Capacitor shell, user agent tail "DiscipleApp/", lib/native) gets html.app before the first paint: its
 *  own home (components/app/AppSwitch) and tab bar (LobbyTopBar). */
const APP_JS = `(function(){try{if(navigator.userAgent.indexOf("DiscipleApp/")>-1)document.documentElement.classList.add("app")}catch(e){}})()`;

/** Top bar holds still on a refresh (maker 2026-11-18): a browser with a saved, unexpired session (lib/aa/sessionState
 *  SESSION_LS) gets html[data-you] before the first paint, so the server-rendered bar is already the signed-in one.
 *  LobbyTopBar keeps it in sync once Privy answers. */
// …and paints the pill saved last time (lib/walletState LastPill) into the wallet placeholder (components/AppShell WalletSlot)
// through CSS vars, so cash, name, level and picture show before any script has loaded
const YOU_JS = `(function(){try{var d=document.documentElement,L=localStorage,s=JSON.parse(L.getItem("disciple.aa.session.v2")||"null");if(!(s&&s.owner&&(!s.expiresAt||s.expiresAt>Date.now())))return;d.setAttribute("data-you","");var w=(L.getItem("disciple.lastWallet")||"").toLowerCase(),p=JSON.parse(L.getItem("disciple.lastPill")||"null");if(!p||!w||String(p.address||"").toLowerCase()!==w)return;var q=function(v){return JSON.stringify(String(v).slice(0,40))},S=function(k,v){d.style.setProperty(k,v)};if(p.cash)S("--pp-cash",q(p.cash));if(p.label)S("--pp-name",q(p.label));if(p.level){S("--pp-lv",q(p.level));d.setAttribute("data-pp-lv","")}var i=p.img;if(typeof i=="string"&&(i.charAt(0)=="/"||i.indexOf("https://")===0)&&!/["'()<>]|[\\s\\\\]/.test(i)){S("--pp-img","url("+JSON.stringify(i)+")");d.setAttribute("data-pp-img","");if(p.nft)d.setAttribute("data-pp-nft","")}}catch(e){}})()`;

const SITE_TITLE = "DISCIPLE · Multiplayer memecoins";
const SITE_LINE = "Multiplayer memecoins and 1v1 trading duels. Launch your own coin with a crew, or take on another trader for one minute.";
/** Site card (step 7): drawn by /api/og/site (lib/server/og/card.ts). Rocket, pilot and invite pages carry their own. */
const SITE_CARD = { url: "/api/og/site", width: 1200, height: 630, alt: "DISCIPLE: Multiplayer memecoins. 1v1 trading duels." };

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_LINE,
  metadataBase: new URL("https://www.disciple.vip"),
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

/** Structured data (SEO/AEO pass, maker 2026-11-18): tells search and AI answers what DISCIPLE is and links the X account. */
const SITE_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": "https://www.disciple.vip/#org", name: "DISCIPLE", url: "https://www.disciple.vip", logo: "https://www.disciple.vip/icon-512.png", sameAs: ["https://x.com/disciplevip"] },
    { "@type": "WebSite", "@id": "https://www.disciple.vip/#site", name: "DISCIPLE", url: "https://www.disciple.vip", description: SITE_LINE, publisher: { "@id": "https://www.disciple.vip/#org" } },
    { "@type": "VideoGame", name: "DISCIPLE", url: "https://www.disciple.vip", description: SITE_LINE, genre: ["Trading", "Multiplayer"], gamePlatform: ["Web browser", "iOS"], playMode: ["MultiPlayer", "SinglePlayer"], publisher: { "@id": "https://www.disciple.vip/#org" } },
  ],
});

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
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${instrumentSerif.variable} ${barlowCondensed.variable}`}>
      <body className="antialiased" suppressHydrationWarning>
        {/* speed pass (2026-11-14): Sidebar sets body.game (no rail on desktop flight) only after hydration, so the full-screen
            flight canvas first painted 64 px to the right and then jumped left: a 0.31 layout shift on every desktop flight
            load. Same test as Sidebar's isCollapsibleRoute, before the first paint; Sidebar keeps it in sync after that. */}
        <script dangerouslySetInnerHTML={{ __html: GAME_ROUTE_JS }} />
        <script dangerouslySetInnerHTML={{ __html: APP_JS }} />
        <script dangerouslySetInnerHTML={{ __html: YOU_JS }} />
        {/* Privy's session check and wallet iframe live on auth.privy.io: open the connection while the page loads */}
        <link rel="preconnect" href="https://auth.privy.io" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: SITE_LD }} />
        <script id={SPONSORSHIP_CONFIG_ID} type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify(sponsorshipConfig()) }} />
        <IconSprite />
        <IosZoomLock />
        <AppSounds />
        <PrivyProviders>
          <AppShell>{children}</AppShell>
          <ChatBridge />
          <LevelUpFlash />
        </PrivyProviders>
      </body>
    </html>
  );
}

/**
 * DISCIPLE iPhone app (native app plan, maker 2026-11-14: Capacitor wrap, Apple App Store only).
 *
 * The app is a thin native shell that loads the live site, so every Vercel deploy reaches the app with no store review.
 * A new store build is only needed when the native side changes (plugins, icon, permissions, this file).
 * The site detects the app through `window.Capacitor` and the "DiscipleApp/1" user agent tail (web/lib/native.ts).
 *
 * DISCIPLE_APP_URL overrides the site (a Vercel preview, or http://<your-mac-ip>:3000 for local dev) at `cap sync` time.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const url = process.env.DISCIPLE_APP_URL || "https://disciple.vip";
const host = new URL(url).hostname;

const config: CapacitorConfig = {
  appId: process.env.DISCIPLE_BUNDLE_ID || "vip.disciple.app",
  appName: "DISCIPLE",
  webDir: "www",
  appendUserAgent: "DiscipleApp/1",
  backgroundColor: "#0B0C0E",
  server: {
    url,
    hostname: host,
    cleartext: url.startsWith("http://"),
    errorPath: "offline.html",
    // Pages that must stay inside the app (sign-in round trips). Any other site opens in Safari. Keep this list short:
    // pages on it can reach the native plugins. A preview deploy is added through DISCIPLE_APP_URL (host above).
    allowNavigation: [
      host,
      "*.disciple.vip",
      "auth.privy.io",
      "*.privy.io",
      "appleid.apple.com",
      "x.com",
      "*.x.com",
      "twitter.com",
      "*.twitter.com",
      "*.moonpay.com",
    ],
  },
  ios: {
    // the site already pads for the notch and home bar (viewport-fit=cover + env(safe-area-inset-*))
    contentInset: "never",
    scrollEnabled: true,
    allowsLinkPreview: false,
    preferredContentMode: "mobile",
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 600, launchAutoHide: true, backgroundColor: "#0B0C0E", showSpinner: false },
    StatusBar: { style: "DARK", overlaysWebView: true },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;

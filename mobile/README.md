# DISCIPLE iPhone app

A Capacitor shell around the live site (native app plan, maker 2026-11-14: Capacitor wrap, Apple App Store only,
Turbo as practice duels with fake money). The app loads `https://disciple.vip`, so every Vercel deploy reaches the app
with no App Store review. Only a change to this folder (plugins, icon, permissions, `capacitor.config.ts`) needs a new
store build.

## What's native

| Piece | Where |
|---|---|
| Taptic Engine haptics for every boost, dump, fill and orbit (instead of the web vibration path) | `web/lib/native.ts` `NATIVE_HAPTICS`, `web/lib/game/haptics.ts` |
| Push alerts through Apple (APNs), same alerts, switches and 3-a-day cap as web push | `web/lib/server/apns.ts`, `web/lib/server/push.ts`, Settings → Alerts |
| Unread badge on the icon, cleared when the app opens | APNs payload `badge: 1`, `ios/App/App/SceneDelegate.swift` |
| Universal links: disciple.vip links (coin pages, duel invites, share cards) open the app | `ios/App/App/App.entitlements`, `web/app/.well-known/apple-app-site-association` |
| `disciple://` links | `Info.plist` `CFBundleURLTypes`, `web/lib/native.ts` `deepLinkPath` |
| Long-press icon shortcuts: Play now, Free play, Launch a coin, Trading Duel | `Info.plist` `UIApplicationShortcutItems`, `SceneDelegate.swift` |
| Screen stays on mid-flight | `@capacitor-community/keep-awake`, `web/components/TouchKit.tsx` |
| Native share sheet for share cards | the site's existing `navigator.share` calls (the app's web view supports them) |
| Sign in with Apple (Google is hidden: Google blocks sign-in inside apps) | `web/components/PrivyMount.tsx` `loginMethodsFor` |
| Delete account inside the app (App Review 5.1.1(v)) | Settings → Security → Delete account, `POST /api/account/delete` |
| Dark status bar, launch screen, offline screen, portrait only, iPhone only | `capacitor.config.ts`, `Info.plist`, `www/offline.html` |
| Turbo stays on practice fuel in the app (App Review 3.1.5(iv)) | `web/lib/turbo/index.ts` `realTurboAllowed()` |
| Engine rumble that follows the thrust, a heavy thud on bomb hits, rising ticks on zones (Core Haptics) | `ios/App/App/DiscipleHapticsPlugin.swift`, `web/components/flight/NativeRumble.tsx`, `web/lib/native.ts` `CORE_FEEL` |
| Your flight on the lock screen and in the Dynamic Island (ticker, zone, mcap, bag, PnL), kept current by the server once a minute while the app is closed | `ios/App/DiscipleWidgets/` (widget extension), `ios/App/App/DiscipleFlightPlugin.swift`, `web/components/flight/LiveFlight.tsx`, `web/lib/server/liveActivity.ts`, `/api/cron/live-activity` |

No Face ID on trades (maker: it slows trading down).

The flight also got phone-wide pieces that work in the browser too: spin / flip tricks, style fills (XP), full-screen flying,
tilt to steer (Settings) and the trade clip (the Clip button on the flight screen).

The two app plugins live in the App target and are registered by `DiscipleBridgeViewController.swift`. The widget
extension target `DiscipleWidgets` (bundle id `vip.disciple.app.widgets`, iOS 16.2+) is embedded in the app; in Xcode pick
your team for it too (Signing & Capabilities). A home screen widget (Free play timer, best rocket) can join the same extension later.

## One-time setup (maker)

1. **Vercel env** (production): `APPLE_TEAM_ID` (Apple Developer → Membership, 10 characters). For push alerts also
   `APNS_KEY_ID`, `APNS_TEAM_ID` (same team id) and `APNS_KEY_P8`: Apple Developer → Certificates, IDs & Profiles → Keys →
   + → tick "Apple Push Notifications service (APNs)" → download the .p8 once and paste its whole text. Optional
   `APNS_BUNDLE_ID` if you change the bundle id from `vip.disciple.app`.
2. **Privy dashboard**: Login methods → turn on **Apple**. Under App settings → Domains, keep disciple.vip allowed.
3. **App Store Connect**: My Apps → + → New App, platform iOS, bundle id `vip.disciple.app` (Xcode creates the id the first
   time it signs), primary category **Finance**, age rating 18+.

## Build and run (on a Mac with Xcode 16+)

```sh
cd mobile
npm install
npx cap sync ios        # copies capacitor.config into the Xcode project and links the plugins
npx cap open ios        # opens Xcode
```

In Xcode: select the **App** target → Signing & Capabilities → pick your team, then the same for **DiscipleWidgets**. Xcode turns on Push Notifications,
Associated Domains and Sign in with Apple from `App.entitlements`. Plug in an iPhone and press Run.

To point the app at a preview deploy or your Mac while testing: `DISCIPLE_APP_URL=https://<preview>.vercel.app npx cap sync ios`
(or `http://<your-mac-ip>:3000` for `pnpm dev`), then Run again. Sync once more without it before a store build.

## TestFlight and submission

1. Xcode → Product → Archive → Distribute App → App Store Connect → Upload.
2. App Store Connect → TestFlight: add yourself and testers, install with the TestFlight app.
3. Check on a real iPhone: sign in with email, Apple and X; boost and dump buzz; turn on Alerts in Settings and receive one;
   open a disciple.vip coin link from Notes or Messages (it should open the app); long-press the icon; Delete account on a
   test account; airplane mode shows the "No signal" screen.
4. App Review notes, in plain words: players hold their own keys (Privy self-custody wallets); card top-ups go through
   MoonPay; Turbo duels use practice fuel only, no real leverage in the app; no cash prizes between players; no rewards for
   invites or social posts. Give the reviewer a demo login with a few dollars in its wallet.
5. Pick launch countries in Pricing and Availability (leave out the UK, sanctioned countries, China and Russia).

## Files

- `capacitor.config.ts`: app id, name, site URL, which sign-in pages may stay inside the app, plugin settings.
- `ios/`: the Xcode project (Swift Package Manager, no CocoaPods). `ios/App/App/public` and `capacitor.config.json` are
  generated by `cap sync` and not committed.
- `www/`: the offline screen (the app shows it when disciple.vip can't be reached).
- `scripts/make-assets.mjs`: re-renders the icon and launch screen from `web/public/brand/disciple-mark-light.svg`.

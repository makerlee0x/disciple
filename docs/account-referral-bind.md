# Account referral bind (first link saved at sign-in)

Lee's yes, Nov 11 2026, 11:32 PM CT: save the first referral link to the account when they sign in, then pay by hand from the payout spreadsheet. No public earnings page. The Rewards popup totals stay the only player-facing referral UI.

## What this is based on

The usual affiliate pattern used by Rewardful and Impact: keep the first touch in a cookie, then attach it to the account when the visitor signs up or signs in. After that the account owns it, not the browser.

What was checked first:

- `docs/funnel-and-referral-attribution-design.md` already names the Rewardful/Impact first-touch pattern (30 days, first link wins).
- `web/lib/referral.ts` + `components/RefCapture.tsx` + `app/r/[username]/route.ts` already do the first touch (`disciple_ref` cookie → `disciple.refv2`). The cookie is only written when a wallet is present (#303).
- `web/lib/server/referralLedger.ts` already writes the fee-slice rows and the daily CSV (`GET /api/cron/referral-payout`). Before this change it only used `ReferralRegistry.referrerOf`, which is locked on-chain only through `tryAttribute`. Nothing is locked on the live test network, so the sheet was empty.
- `web/lib/server/privyAuth.ts` + `lib/server/inviteGate.ts` (`inviteDeps().accountsOf`) already turn a Privy session into the account's wallets and smart accounts (used by `/api/invites`, `/api/pve/attest`).
- `web/lib/profile.ts` `rememberReferrer` (`disciple.ref`) is an older browser-only username store. Not used here.

Nothing in the repo already saved the referral to the account on the server, so this adds only that step.

## How it works

1. Browser: unchanged first touch. `RefCapture` now also loads `lib/referralBindClient.ts` in its own chunk. On the existing signed-in events (`lib/wallet` `onWallet` + `canTransact`, the same moment the funnel `signin` step uses, and `lib/aa/session` `onPrivy`), if `currentRef()` has a referrer wallet that is not the player, it POSTs `{ wallet, ref }` once to `/api/referral/bind` with the Privy access token. Every failure is ignored. Login and trading are not changed.
2. Server: `POST /api/referral/bind` → `lib/server/referralBind.ts` `handleBind`. Privy session required; the posted wallet must be one of the account's wallets. `bindAccountReferrer` then:
   - refuses a touch with no wallet, an expired touch (same `parseRef` 30-day rule), or a referrer that is one of the account's own wallets;
   - `SET NX` `referral:<chain>:bind:acct:<privyDid>` (first write wins, no TTL);
   - copies that saved referrer with `SET NX` to `referral:<chain>:bind:<wallet>` for each account wallet.
   Stored value: `{ r, t, at }` (referrer wallet, first-touch time, bind time). No email, IP, or other personal data.
3. Payout sheet: the ledger's default referrer lookup is now `accountReferrerOf(trader)` (the wallet bind key). `ReferralRegistry.referrerOf` is kept as `registryReferrerOf`, unused for this payout.

Once saved, clearing cookies, a later link, or another browser does not change it.

## Username claim or change (wallet without the Easy / Privy session)

Lee's yes, Nov 11 2026, 11:47 PM CT: do the wallet save off-chain; when someone changes their username, link the wallet they used to sign in with that username.

Same Rewardful / Impact first-touch-then-bind pattern, hooked into the existing wallet-signed `POST /api/profile/username` (no new login or signature). After a successful first claim or later change (signature, nonce, invite and cooldown checks unchanged; username ↔ wallet is saved as before), the route calls `bindWalletReferrerSafe` in `lib/server/referralBind.ts`:

- First touch: the posted `ref` (the browser's `currentRef()`, the same payload `/api/referral/bind` gets) if it has a wallet, else the `disciple_ref` cookie on the request. Same `parseRef` 30-day rule.
- `SET NX` `referral:<chain>:bind:<wallet>` on the signed wallet only (no Privy account on this path). Same `{ r, t, at }` value. First write wins, never overwrites, refuses self-referral (the signed wallet, or its smart-account owner) and username-only or expired touches.
- Best effort: errors are swallowed and it gives up after 1.5 s, so the username answer never changes.

Both paths share the wallet key, so whichever saves first wins. If a Privy sign-in comes later, the account adopts the wallet's earlier referrer instead of the new touch. The Privy sign-in bind is unchanged and still works on its own.

## Not changed

Cookie first touch, `/r/` links, `tryAttribute`, the on-chain ReferralRegistry, the attestor, the USDG deposit hook, `referralSink`, the Rewards popup, login, trading.

## Known limits

- A plain external-wallet session binds only when it claims or changes a username (above). Otherwise only Privy sign-ins bind.
- A player can still pick any referrer wallet by visiting that link first, or refer themself with a second account. Same limit as any cookie-based affiliate program; lee reviews the sheet before paying.
- Trades from before the bind are not paid (same as before: a fill with no referrer is marked seen).

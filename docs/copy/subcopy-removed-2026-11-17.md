# Subcopy removed, 17 Nov 2026 (revert record)

Every subtitle, helper line, caption and empty-state blurb that the subcopy pass removed or changed, so any line can be put back.

- **Source audit:** `subcopy-audit-2026-11-16.md` (148 rows: 95 DELETE, 11 REPLACE WITH ICON/VISUAL, 42 KEEP), audited on main `c5bc9a45`.
- **Applied on:** main `3845569b` (after #452). Line numbers below are from that commit, so `git show 3845569b:<file>` shows the original in place.
- **Fast revert:** `git revert <merge commit>` undoes the whole pass. To restore one line, copy the "Original" text back into the file named in its row.
- **Kept on purpose:** money, safety and can't-undo lines (wrong network, can't be pulled back, export key, delete account, loss warning, fee permanence, public-record warning, hold to dump all, push permission errors). Rows marked KEEP are listed where they sit next to changes, so it's clear they were looked at.

### maker's adjustments on top of the audit

1. `Hidden launches fly on Expert.` changed (hidden launches work on every difficulty after #445). See the Launch table: it now reads `…for now.` and disappears when `ANON_ANY_MODE_LIVE` flips at the mainnet deploy.
2. `wallet` dropped from every "email, Google, X or wallet" line (sign-in is Privy-only).
3. Duel `500×` kept and flagged as a placeholder pending Nova's gears.
4. Coin page flagged-copy warning cut to one line.
5. Leaderboard and duel rating explainers removed from the page; the rules sit behind a small ⓘ next to the title.

## Live flights (/live)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/app/live/page.tsx:23 | `{n} rocket(s) flying now. Pick one and climb aboard.` | Red live dot + `{n} flying` |
| web/app/live/page.tsx:23 | `Nothing flying right now. Host a launch and be the first.` | `Nothing flying` |
| web/app/live/page.tsx:28 | `No rockets on the pad yet.` | Removed (Host a launch button stays) |

## Lobby, signed out (web/components/home/LobbySignedOut.tsx)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| LobbySignedOut.tsx:185 | Eyebrow `How it plays` | Removed |
| LobbySignedOut.tsx:187 | Step 1: `**Boost** buys a seat and lifts the rocket for everyone.` | Removed |
| LobbySignedOut.tsx:188 | Step 2: `**Dump** cashes you out and drops a bomb on the way.` | Removed |
| LobbySignedOut.tsx:189 | Step 3: `**Win** by cashing out for more than you put in. Seats cost real cash.` (coin `3`) | `$` coin mark + `Seats cost real cash.` |
| LobbySignedOut.tsx:207 | Top pilots sub `Biggest cash-outs, in real money` | Removed |
| LobbySignedOut.tsx:233 | `No cash-outs {yet today / this {window} yet}. The first pilot to cash out higher takes the top spot.` | `No cash-outs yet` |
| LobbySignedOut.tsx:261 | Eyebrow `Host a match` | Removed |
| LobbySignedOut.tsx:263 | `Pick the difficulty and light the engines. You earn a cut of every boost and dump.` | Removed (heading + Start a launch) |
| LobbySignedOut.tsx:289 | Flying now sub `Pick one and jump in` | Removed |

## Lobby, both states (ModeSelect, Lobby shelves, Join a flight, foot steps)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/components/home/ModeSelect.tsx:30 | Host a launch card sub `Build a rocket. The crew flies it up.` | Removed (art + title + `Real coins` tag) |
| web/components/home/ModeSelect.tsx:31 | Live flights card sub `Jump on a rocket that's already climbing.` | Removed (`{n} flying` tag) |
| web/components/home/ModeSelect.tsx:32 | Trading duel card sub `1v1. One minute. Most profit wins.` | Removed (`Ranked` tag) |
| web/components/home/ModeSelect.tsx:33 | Turbo royale card sub `12 pilots. Loot leverage. Last one flying wins.` | Removed (`Practice` tag) |
| web/components/home/ModeSelect.tsx:34 | Free play card sub `No cash. Today's daily flight.` | Removed (`Free` tag) |
| web/components/home/ModeSelect.tsx:126,138 | `sub` field on `Mode`, rendered as `<span className={s.sub}>`, used in aria-label | Field removed; aria-label now `{title}. {tag}`. To restore: add `sub` back to the type + data and re-add the span |
| web/components/home/Lobby.tsx:105 | Climbing now shelf sub `Biggest climbs today` | Removed (ShelfHead `sub` is now optional) |
| web/components/home/Lobby.tsx:116 | About to reach orbit shelf sub `Boost now and you're aboard when it graduates` | Removed |
| web/components/home/Lobby.tsx:137 | Fresh off the pad shelf sub `The newest launches` | Removed |
| web/components/home/Lobby.tsx:165-170 (data), 177-185 (render) | `STEPS` foot cells: `01 Launch: Build a rocket and open the hatch.` / `02 Join: Drop into any live flight.` / `03 Climb: Boost lifts the whole crew. Dump drops a bomb.` / `04 Reach orbit: Climb past the Kármán Line and the rocket graduates.` | Cells removed; only the `How to play ›` link stays |
| web/components/home/JoinFlight.tsx:89 | Chart empty `Waiting for the first trades of the day…` | Grey pulse dot (aria-label "Waiting for trades") |
| web/components/home/JoinFlight.tsx:151 | Chart loading `Reading the market…` | Grey pulse dot (aria-label "Loading chart") |
| web/components/home/JoinFlight.tsx:117 | `No rockets are in the air right now. Host the first launch and your crew flies it up, or warm up in Free play.` | Removed (the `Nothing flying yet` chip + Host a launch / Free play buttons stay) |

## Shell: Turbo menu, sidebar, sign-in window, welcome toast
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/components/LobbyTopBar.tsx:44 | Turbo menu, Trading duel sub `1v1. One minute. Most profit wins.` | `Ranked` |
| web/components/LobbyTopBar.tsx:45 | Turbo menu, Turbo royale sub `12 pilots. Last one flying wins.` | `Practice` |
| web/components/Sidebar.tsx:48,289 | Signed-out card line `Sign in with email, Google, X or wallet` (`JOIN_LINE`) | Email / Google / X marks (new `web/components/SignInMarks.tsx`); no wallet mark, sign-in is Privy-only |
| web/lib/walletCta.ts:27 + web/components/PrivyMount.tsx:202 | Privy window `loginMessage`: `One sign-in, then every boost is one tap. No wallet needed.` (`SIGN_IN_COPY.line`) | Removed (Privy shows the header + method buttons only) |
| web/lib/walletCta.ts:33 + web/components/account/WelcomeToast.tsx:48 | Welcome toast body `Add cash to take your first seat. Your Hangar is ready.` (`SIGN_IN_COPY.welcomeBody`) | Removed (title `You're in, pilot` + Add cash / Later) |
| web/components/InAppBanner.tsx:45-46 | `Open in {Safari/Chrome} to play…` | KEEP, unchanged |

## Launch (/create)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/components/create/LaunchPad.tsx:31 | Eyebrow `Host a match` | Removed |
| web/app/create/page.tsx:548 | Step 1 sub `Shuffle for ideas` | Removed |
| web/app/create/page.tsx:568 | Step 2 sub `Made from your name` | Removed |
| web/app/create/page.tsx:597 | `Or upload your own: PNG, JPG, WEBP or GIF, up to 2 MB.` | Removed (upload errors still show) |
| web/app/create/page.tsx:601 + web/lib/quickLaunch.ts:22 | Difficulty sub `Locked at launch. The caps switch off once the rocket reaches orbit.` | Lock icon + `Locked at launch`; orbit clause moved to the hover title |
| web/lib/quickLaunch.ts:19 | Easy: `Small bags only. No one can hold more than 1% at first, so the whole crew climbs together.` | `Max bag 1%, rises to 3.33%` (+ 1-bar meter) |
| web/lib/quickLaunch.ts:20 | Hard: `Bigger bags, up to 3.33% each at first. More room for whales, bigger bombs.` | `Max bag 3.33%, rises to 7.77%` |
| web/lib/quickLaunch.ts:21 | Expert: `No caps at all. Anyone can grab as much as they want. Wild climbs, wilder dumps.` | `No bag cap` |
| web/app/create/page.tsx:623 | Step 4 sub `First boost, at launch` | Removed |
| web/lib/quickLaunch.ts:44 + web/components/create/FirstBoostField.tsx:218 | Seat note `You get first dibs on your own rocket. Skip it with $0.` (`seatHelp`) | Removed; the note line now only shows the cap / Easy-lock rules when they apply |
| web/lib/quickLaunch.ts:43 | `firstBoostTip` `This is your first buy, at launch…` | Not changed: only used by the `chips` variant of FirstBoostField, which nothing renders |
| web/app/create/page.tsx:633 | Extras sub `Optional` | Removed |
| web/app/create/page.tsx:638 | Hide my name off-state `You won't show as the host.` | Removed (on-state public-record line kept) |
| web/lib/quickLaunch.ts:78-80 | Anon / pseudo public-record lines | KEEP, unchanged |
| web/app/create/page.tsx:641 | `Hidden launches fly on Expert.` | `Hidden launches fly on Expert for now.` It only shows while `ANON_ANY_MODE_LIVE` (web/lib/anonModes.ts) is false; the any-difficulty contracts from #445 aren't deployed yet. Flipping that flag at the mainnet deploy hides the line |
| web/app/create/page.tsx:459 + web/lib/quickLaunch.ts:54 | Pair coin sub `Your rocket is bought and sold in this coin.` (`pairHelp`) | Removed |
| web/app/create/page.tsx:476 | Links sub `Shown on your rocket` | Removed |
| web/app/create/page.tsx:487 | Creator tax sub `Extra cut on every trade` | Removed |
| web/lib/quickLaunch.ts:177 (`CREATOR_TAX_HELP[0]`) | `You already get 33% of every trading fee. Creator tax is an extra cut on top of that. Higher tax can scare off players.` | `Added on every trade, and you can't change it later.` |
| web/lib/quickLaunch.ts:178 (`CREATOR_TAX_HELP[1]`) | `The 33% of every trading fee goes into the locked pool. Creator tax is an extra cut on top of that, and it goes there too. Higher tax can scare off players.` | `Added on every trade and goes into the locked pool. You can't change it later.` |
| web/lib/quickLaunch.ts:179 (`CREATOR_TAX_HELP[2]`) | `The 33% of every trading fee is used to buy and burn the pair coin. Creator tax is an extra cut on top of that, and it is used the same way. Higher tax can scare off players.` | `Added on every trade and buys and burns the pair coin. You can't change it later.` |
| web/app/create/page.tsx:520 | Fee payout sub `Optional` | Removed |
| web/lib/quickLaunch.ts:74 | `signInLine` `Sign in with email, Google, X or wallet` (not rendered anywhere) | `Sign in with email, Google or X` |
| 33% fee split, `you can't change it later`, fee payout help | KEEP, unchanged |
| Tests | web/scripts/test-quick-launch.mts and web/e2e/launch.spec.ts updated to the new strings |

## Hangar, profile, Your rocket, Trophies
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/components/hangar/HangarSections.tsx:65 | Fleet sub `Rockets you're aboard` / `Rockets {owner} is aboard` / `Rockets you launched` / `Rockets {owner} launched` | Removed (the Aboard / Launched tabs name the list) |
| web/components/hangar/HangarSections.tsx:74 | Own aboard empty body `Drop into a live flight from the lobby and boost it. It shows up here.` | Removed (`No seats yet` + Find a flight stay) |
| web/components/hangar/HangarSections.tsx:75 | Own launched empty body `Host a match: build a rocket and open the hatch.` | Removed (`Nothing launched yet` + Start a launch stay) |
| HangarSections.tsx:74-75 public empties | `{owner} isn't aboard…` / `{owner} hasn't launched…` | KEEP, unchanged |
| web/components/hangar/HangarSignedOut.tsx:16 | Bay body `Sign in to park your rocket here. Your level, your fleet and your trophies all live in the Hangar.` (`HANGAR_OUT_COPY.body`) | Removed |
| web/components/hangar/HangarSignedOut.tsx:17-21 | Perks: `Level up from your first boost` (#5FF0A0) / `See every rocket you're aboard in one place` (#A9C4FF) / `Collect trophies and claim your rewards` (#F2C14E), rendered in a `.hgo-bio` div passed as `bio` | Removed; `bio={null}`. CSS `.hgo-bio` left in app/refresh-r2.css for a restore |
| web/components/hangar/Collection.tsx:193 | Your rocket sub `Every skin is made for one hull. Every copy you find is rolled on its own: a serial, a burn and a pattern.` | Removed |
| web/components/hangar/Collection.tsx:202 | `Your name tag floats over your rocket in every race.` | Removed (the tag preview sits right above it) |
| web/components/hangar/Collection.tsx:226 | Trail sub `Gold core, so you stay easy to spot` | Removed |
| web/components/hangar/Collection.tsx:237 | Name tag sub `Prestige plates come with each Prestige` | Removed |
| web/components/hangar/Collection.tsx:248 | Win flourish sub `Plays over your rocket when you win a duel` | Removed |
| web/components/hangar/Collection.tsx:273 | `No spare copies yet. Spares are the extra copies you find of things you already have.` | `No spares yet` |
| web/components/hangar/Collection.tsx:309 | Crates sub `Ranked duel wins and weekly missions drop crates.` | Removed |
| web/components/hangar/Collection.tsx:331 | Crates empty `Win a ranked duel or finish your weekly missions to get one.` | KEEP, unchanged |
| web/components/hangar/Collection.tsx:93 | `You have {n} copies{ · {made} made}. Every copy is rolled on its own.` | `You have {n} copies{ · {made} made}` |
| web/components/hangar/RocketPage.tsx:46 | Signed-out body `Your skins, trails and crates live here, and they fly in every mode.` | Removed (`Sign in to see your rocket` + Sign in stay) |
| web/lib/copy/profile.ts:55, 76, 78, 80, 83, 91, 92 | Edit profile helpers (photo, bio, links, flag, title, title empty) | Not changed: none of these keys are rendered on main (EditProfileSheet doesn't use them) |
| web/components/profile/ProfileDashboard.tsx:50 | Flight log empty body `BOOST a rocket and your war log starts.` (`activity.empty.own.body`) | Removed (`No activity yet` stays). Unused tabs/ActivityTab + RocketsTab left alone |
| lib/copy/profile.ts:71-73, 104 | Username cooldown + signature line | KEEP, unchanged |
| web/components/xp/TrophiesPage.tsx:127 | Lede `Missions pay XP. Level up to unlock new paint for your rocket.` | Removed |
| web/components/xp/TrophiesPage.tsx:181 | Signed-out `Sign in and boost a rocket. Your XP and level show up here.` | Removed (`Start at level 1` + Play now stay) |

## Wallet / Cash (web/components/cash/CashBody.tsx)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| CashBody.tsx:35,258 | Balance sub `Spend it on any coin, or load it into Turbo.` (`CASH_COPY.balSub`) | Removed |
| CashBody.tsx:68,226 | Signed-out body `Email, Google, X or a wallet. Your cash lives in your own account.` (`CASH_COPY.signInBody`) | Email / Google / X marks (`SignInMarks`); no wallet, sign-in is Privy-only |
| CashBody.tsx:110 | `No cash yet? **Fly in Free play** while it lands.` | Plain `Free play` link |
| CashBody.tsx:43-58, lib/fund.ts:32,35, lib/deposit.ts:43-47 | Network / USDG-only / can't-be-pulled-back / MoonPay / bridge timing + fee lines | KEEP, unchanged |

## Settings (web/components/profile/SettingsModal.tsx, web/components/push/PushSettings.tsx, web/lib/push.ts)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| SettingsModal.tsx:23,306 | Footer `Deposit and withdraw on the Wallet page.` (`walletHelp`) | Removed; footer is now just Sign out (right-aligned, app/profile-r5.css `.p5-sfoot` justify-content flex-end, was space-between) |
| web/lib/push.ts:31 + PushSettings.tsx:119 | Alerts footer `At most 3 pushes a day, all off by default except orbit. Settings has one switch per kind.` (`pushCopy.rule`) | `At most 3 a day.` |
| PushSettings.tsx:25,108 | Device row help `Pushes for the switches below. You can turn them off here any time.` (`deviceHelp`) | Removed (the unsupported-browser error still shows when it applies) |
| web/lib/push.ts:10 | Orbit help `A rocket you're aboard reaches orbit.` | Removed (`help` field dropped from `PUSH_KINDS`) |
| web/lib/push.ts:11 | Host help `Passenger milestones on rockets you launched.` | Removed |
| web/lib/push.ts:12 | Crew help `Your crew's rocket climbs past the Kármán Line.` | Removed |
| PushSettings.tsx:26-27 | Blocked / iPhone / unsupported errors | KEEP, unchanged |
| SettingsModal.tsx:30,217 | One-tap help `BOOST and DUMP fire with no pop-up` | Removed |
| SettingsModal.tsx:25,232 | Dump bombs help `Show dumps as bombs · B` | Removed |
| SettingsModal.tsx:26,242 | Vibration help `Buzz on taps and big moments` | Removed |
| SettingsModal.tsx:28,262 | Music help `Plays while you fly and duel` | Removed |
| SettingsModal.tsx:29,262 | Sound effects help `Engines, boosts and blasts` | Removed |
| SettingsModal.tsx:33 | Price protection `Max price move per trade. Bigger moves cancel it` | KEEP, unchanged |
| web/lib/turbo/leave.ts:29 + SettingsModal.tsx:248 | Turbo leave help `Keep it in Turbo, or move it back to cash` (`LEAVE_COPY.settingHelp`) | Removed |
| SettingsModal.tsx:37 | Export key `Whoever has it controls your money` | KEEP, unchanged |
| SettingsModal.tsx:44,174 | Passkey help `Sign in with your device's biometrics` | Removed |
| SettingsModal.tsx:45 | `Available when you sign in with email, Google, X or a wallet.` | `Available when you sign in with email, Google or X.` (sign-in is Privy-only) |
| SettingsModal.tsx:48,297 | Delete row sub `Remove your profile and sign-in` | Removed (the confirm screen keeps the full warning) |
| SettingsModal.tsx:50-51,56 | Delete confirm lead + wallet warning, signed-out line | KEEP, unchanged |

## Coin page / flight HUD
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/components/NameLockCopyBanner.tsx:19 | `Flagged copy: a rocket that has reached orbit already uses this name and call sign. Reaching orbit means its starting price path finished and it moved to the open market on Uniswap. This one launched after that lock. It can still be traded.` | `Copycat: a rocket that already reached orbit owns this name and ticker. This one can still be traded.` |
| web/components/flight/LaunchedToast.tsx:60 | Default body `You're the host. Every trade pays you a cut.` | Removed (a handoff `note`, when set, still shows) |
| web/app/coin/[address]/page.tsx:91-93 | Not-found state | KEEP, unchanged |
| web/components/home/HowItWorks.tsx:17 | Quick help lede `Seats cost real cash. Cash out for more than you paid in, and you win.` | KEEP, unchanged |
| web/components/home/HowItWorks.tsx:19 (desktop) | Boost body `Pick an amount, then hit Space. Your cash buys a seat and lifts the rocket.` | Removed; key chips 1-4 + Space stay |
| web/components/home/HowItWorks.tsx:21 (desktop) | Dump body `Pick how much, then hit Shift. You get cash back and drop a bomb.` | Removed; key chips Z X C V + Shift stay |
| web/components/home/HowItWorks.tsx:23 (desktop) | Orbit body `At $33,333 the rocket breaks into orbit and the sky opens up. Everyone aboard gets the moment.` | Removed; `$3,333 → $33,333` chip stays |
| web/components/home/HowItWorks.tsx:20 (phone) | `Tap an amount, then BOOST. You buy a seat and lift the rocket.` | `Tap an amount → BOOST` |
| web/components/home/HowItWorks.tsx:22 (phone) | `Tap how much, then DUMP. Hold DUMP ALL to sell everything.` | `Tap how much → DUMP · hold DUMP ALL to sell all` |
| web/components/home/HowItWorks.tsx:24 (phone) | `At $33,333 the rocket breaks into orbit. That's the crew goal.` | `$33,333` |
| HowItWorks.tsx:26-27 | Loss warning (desktop + phone) | KEEP, unchanged |
| web/components/PnlHud.tsx:359-361 + lib/game/i18n.ts:91-92 | Points coach line `▲ more uPnL → bigger points multiplier · hold to ramp` / `stay green to earn a bigger points multiplier` | Removed from the HUD (the ×n / ×max number + bar stay). i18n keys left in place |
| web/components/flight/SettingsMenu.tsx:162 + i18n.ts:36 | Hotkeys note `Preset keys only select. SPACE boosts the active amount (custom $ wins), SHIFT dumps the selected size.` | Removed |
| SettingsMenu.tsx:205 + i18n.ts:42 | Vibration hint `buzz on taps and big moments (iPhone: a light tick)` | Removed |
| SettingsMenu.tsx:208 + i18n.ts:40 | `Music plays during a flight.` | Removed (i18n key kept; scripts/test-in-game-radio.mjs checks it) |
| SettingsMenu.tsx:224 + i18n.ts:47 | Touch Grass hint `ambient: rocket + $TICKER · MCAP only (G)` | Removed |
| i18n.ts:49 | Orbs hint `collectible orbs in the sky (O)` | Not changed: not rendered on main (orbs are retired) |
| PhoneTradeBar.tsx:129 | `Hold to dump all` | KEEP, unchanged |

## Duel (web/public/turbo/duel/engine.js; source file, minified at build by scripts/minify-engine.mjs)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| engine.js:5 (HTML, `#aCap`) | Lobby tagline `Live BTC · 1 minute · the higher rocket wins` | Status line `LIVE BTC · 1 MIN` |
| engine.js:5 (HTML, `#goSub`) + engine.js:830 | Play Online sub `A pilot near your rating. Wins move your rating.` | `Ranked` (signed-out `Sign in to duel a pilot near your rating.` kept: it's the action) |
| engine.js:5 (HTML, `#botSub`) | Play a Bot sub `Practice at this tier. No rating, no sign-in.` | `Practice · play money · no rating` |
| engine.js:856 | Play a Bot sub (later) `A bot at this tier. Play money, no sign-in.` | `Practice · play money · no rating` |
| engine.js:5 (HTML, `#budF`) | `Any budget from $5 to $10K, same for both of you. Trade sizes scale with it. Friendly duels don't change your rating.` | `Friendly · no rating` (an out-of-range budget still errors with `Pick a budget from $5 to $10,000.`) |
| engine.js:5 (HTML, `#lFine`) | `Live BTC · same price for both pilots · 500× · fees count` | KEEP, unchanged. **500× is a placeholder** until Nova confirms gears (100/150/200/1000×); update it with the engine leverage |
| engine.js:5 (HTML, `#lSub`) | Ready check `The chart starts at GO. Same live BTC price for both of you.` | Empty |
| engine.js:777 | Ready check (JS): bot `{bot} · {TIER} · {fuel} fuel · no rating. The chart starts at GO.` / human `The chart starts at GO. Same live BTC price for both of you.` | Bot `{bot} · {TIER} · {fuel} fuel · no rating`; human empty |
| engine.js:844 | Rival slot hints `send them the link` / `pick a tier, then find a match` | Empty (`near {rating}` while searching stays) |
| engine.js:307 | Cash-out button sub with no position `pick a side` | Empty |
| engine.js first-match controls overlay, out of fuel | KEEP, unchanged (the overlay already only shows on the first match) |
| web/components/mobile/WelcomeIntro.tsx:20 | iPhone first launch `Live BTC, 500x. Out-trade a rival and the W is yours. Practice money, no sign-up.` | Not changed by this pass: #453 already replaced it with maker's own copy (`1v1` / `Trading Duel` / `Best PnL in 60 seconds wins.`) |

## Market
| File:line (main 3845569) | Original | Now |
|---|---|---|
| web/components/hangar/MarketView.tsx:32 | Crates strip sub `Open, then list what you pull` | Removed (`N crates ready` + Open stay) |
| MarketShop.tsx:265, 319, 342 | `Paid from Cash`, app gate, empty list | KEEP, unchanged |

## Leaderboard / Top pilots (web/components/leaderboard/LeaderboardView.tsx)
| File:line (main 3845569) | Original | Now |
|---|---|---|
| LeaderboardView.tsx:36,302 | Page sub `Banked profit in real money, losses included. Same board as the lobby shelf, all the way down.` (`LEADERBOARD_COPY.sub`) | Removed |
| LeaderboardView.tsx:191,302 | Duels tab sub `Trading Duel rating from ranked duels. Win to climb, lose and you drop. Friendly duels don't count.` (`DUEL_BOARD_COPY.sub`) | Removed |
| LeaderboardView.tsx:38-41, 223-234, 377 | Permanent "How you rank" panel under the board: `Only cashed-out profit counts, after fees. Red flights count against you.` / `Rockets you launched don't count.` / `Best % only counts flights with $20 or more in.` / note `Tap a pilot to see their Hangar. Open bags stay private.` | Panel removed from the page; the same list now opens from a small ⓘ next to the Top pilots title (styles `.tp-title`, `.tp-info`, `.tp-ibtn`, `.tp-pop` in app/refresh-r2.css) |
| LeaderboardView.tsx:196, 223-234, 377 | Permanent "How duel rating works" panel: `Everyone starts at 1,200.` / `Beat a higher-rated pilot and you gain more. Lose to a lower one and you drop more.` / `Your first 10 duels move your rating faster, so you find your level quickly.` / `Only ranked duels count. Friendly duels and bot matches don't.` | Same: behind the ⓘ on the Duels tab |
| LeaderboardView.tsx:32,48,346 | Empty body `Nobody has cashed out higher {yet today/…}. Be the first and your name goes up here.` (+ `EMPTY_WHEN` map) | Removed (`The top spot is open` + Play now stay) |
| LeaderboardView.tsx:194,329 | Duels empty body `Win a ranked duel and your name goes up here.` | Removed (`No ranked duels yet` + Find a duel stay) |

## iPhone app home (added after #454, on main 798bd3b3; line numbers are from that commit)
| File:line (main 798bd3b3) | Original | Now |
|---|---|---|
| web/components/app/AppHome.tsx:98 | Daily flight card `Same sky for everyone. No cash needed.` | Removed (`Today` tag + `Ends in` timer stay) |
| web/components/app/AppHome.tsx:111 | Duel card `One minute. Most profit wins.` | Removed (`1v1 duel` + Fight stay) |
| web/components/app/AppHome.tsx:133 | Flying now empty `Host the first launch and your crew flies it up.` | Removed (`Nothing flying yet` stays) |
| web/components/app/AppHome.tsx:137 | Host a launch row `Build a rocket. The crew flies it up.` | Removed |
| web/components/app/AppHome.tsx:149 | Turbo royale tile `12 pilots. Last one flying.` | Removed (`Practice` tag stays) |
| web/components/app/AppHome.tsx:155 | Free play tile `No cash. Today's flight.` | Removed (`Free` tag stays) |
| web/components/app/AppHome.tsx:171 | Quick play, Real coins `{n} flying · search and join` / `Host or join a launch` | `{n} flying` / `Nothing flying` |
| web/components/app/LiveRockets.tsx:73 | All rockets sheet empty `Host one yourself and the crew flies it up.` | Removed (Host a launch row sits right below) |
| web/components/app/LiveRockets.tsx:78 | Host a launch row `Build a rocket. The crew flies it up.` | Removed |
| WelcomeIntro.tsx, FirstRunHost.tsx (`SLIDE UP TO BOOST / let go to fire`, `Swipe to pick a mode, tap to play`) | First-run copy | KEEP, unchanged (maker's welcome copy from #453; first-run coach lines show once) |

## Native shell, Quick play, first run (Grok mobile audit; main 0d63d2b3, line numbers from that commit)
| File:line (main 0d63d2b3) | Original | Now |
|---|---|---|
| mobile/ios/App/App/Info.plist:71 | Shortcut subtitle under Play now: `Board the top rocket` | Removed (title + flame icon). Ships with the next native build |
| mobile/ios/App/App/Info.plist:86 | Shortcut subtitle under Free play: `Today's daily challenge` | Removed |
| mobile/ios/App/App/Info.plist:101 | Shortcut subtitle under Launch a coin: `Build your rocket` | Removed |
| mobile/ios/App/App/Info.plist:116 | Shortcut subtitle under Trading Duel: `Practice duel` | `Practice` |
| web/components/app/AppHome.tsx:165 | Quick play, Trading duel `1v1 · 1 minute` | `Practice` (duels in the app are practice money) |
| web/components/app/AppHome.tsx:166 | Quick play, Turbo royale `12 pilots · practice money` | `Practice` |
| web/components/app/AppHome.tsx:167 | Quick play, Free play `Today's flight · no cash` | `Free` |
| web/components/app/AppHome.tsx:168 | Quick play, Real coins `{n} flying` / `Nothing flying` (set in #455; was `{n} flying · search and join` / `Host or join a launch`) | Live dot + `{n} flying`; nothing when empty |
| web/components/mobile/FirstRunHost.tsx:136 | First boost toast sub `You're aboard, pilot.` | Removed (`FIRST BOOST!` stays) |
| web/components/mobile/FirstRunHost.tsx:126 | Cash gate `Boosts spend your cash. Card or Apple Pay works.` | `Card or Apple Pay` |
| web/components/mobile/InstallPrompt.tsx:54 | Add to Home Screen `Opens full screen in one tap, and you get alerts when your crew needs you.` | Removed (the Share / Add to Home Screen steps stay) |
| web/components/cash/CashBody.tsx:314 | `Sent cash can't be pulled back, so check the address.` had class `cx-d` (hidden on phones and in the app) | Now shows on every screen size (class `cx-fine` only) |
| Info.plist motion string, offline.html, Live Activity labels, LiveRockets `{n} flying now`, welcome line, first-run coaches, practice-fuel lead, market gate, push errors, phone USDG warnings | — | KEEP, unchanged |
| web/app/layout.tsx:30 + web/public/site.webmanifest:5 | `Every rocket is a live match. The crew boosts it up, and anyone can bomb it down.` | Not changed: it's the site's search / link-preview description (meta, Open Graph, X card), not in-app copy |

## Not changed (follow-ups)

### Only on open PR #450 (not merged when this pass ran)

Apply these once #450 merges, or fold them into #450:

| Where on #450 | Text | Audit call |
|---|---|---|
| `LobbySignedOut.tsx` climbing hero lede | `{facts}. Boost to grab a seat, dump to cash out.` | DELETE the second sentence, keep the live facts |
| `LobbySignedOut.tsx` climbing hero kicker | `New here? Play a free 1v1 duel · Spec sheet` | DELETE `New here?`; a quiet duel text link can stay |
| `InAppBanner.tsx` title | `Play free right here. Email and X sign-in work in {app}. For sound and Google, open in {Safari/Chrome}.` | KEEP the Google/sound line; title becomes `Open in {browser} for Google and sound` |
| `lib/push.ts` alerts footer | `At most 3 pushes a day, all off by default except orbit and duel requests. Settings has one switch per kind.` | `At most 3 a day.` (main already has this) |
| `lib/push.ts` duel kind help | `A pilot wants a 1v1 trading duel with you.` | DELETE (the `help` field no longer exists on main, so a merge conflict will flag it) |
| `engine.js` start wait | `Waiting for the live BTC price. GO as soon as it lands.` | KEEP |

### Outside the audit's page list (same pattern, not touched)

- Launch builder: panel head `4 steps · about a minute` and More options sub `All optional. Locked in when you launch.`
- `lib/protocol-viem.ts:283` error `Easy rocket: sign in with X, email or wallet to BOOST.` still says wallet.
- Invite, Crew, Logbook, Streaks, Creator dashboard, Rewards popup, Royale in-match HUD, duel result flavor.

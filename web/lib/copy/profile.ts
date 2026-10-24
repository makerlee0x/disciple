/**
 * Profile basics r1: every NEW user-facing string on /profile and /u/[username], in one place so lee / BRAND can swap them.
 * Source: BRAND PROFILE_DIRECTION.md §4 (keys kept). ALL OF THESE ARE PROPOSALS PENDING LEE. Strings that already existed
 * on the site before this change (e.g. "Your Profile", "Sign in (top right)", "Settings", "Share this trade", "Biggest W")
 * are NOT here; they stay where they were.
 */
export const PROFILE_COPY = {
  // Header
  "profile.title.nousername": (short: string) => `Pilot ${short}`,
  "profile.rank.aria": (rank: string) => `Season rank: ${rank}`,
  "profile.level": (lvl: number) => `LVL ${lvl}`,
  "profile.level.aria": (lvl: number) => `Level ${lvl}`,
  "profile.tags.more": (n: number) => `+${n}`,
  "profile.tags.aria": "Identities",
  "profile.bio.empty.own": "Add a bio",
  "profile.stat.winrate": "Win rate",
  "profile.stat.bombs": "Bombs dropped",
  "profile.action.edit": "Edit profile",
  "profile.action.share": "Share profile",
  "profile.share.copied": "Profile link copied",
  "profile.sample": "SAMPLE", // tooltip reuses the existing SAMPLE_DATA_LABEL

  // Tabs + paging
  "profile.tab.rockets": "Rockets",
  "profile.tab.loot": "Loot",
  "profile.tab.achievements": "Achievements",
  "profile.tab.activity": "Activity",
  "pager.prev": "Prev",
  "pager.next": "Next",
  "pager.status": (page: number, pages: number) => `Page ${page} of ${pages}`,

  // Rockets
  "rockets.filter.holding": (n: number) => `Holding ${n}`,
  "rockets.card.pnl.aria": (amount: string) => `PnL ${amount}`,
  "rockets.live.change": (amount: string) => `${amount} 24h`, // live holdings: 24h value change (not in BRAND table)
  "rockets.empty.own.title": "No rockets yet",
  "rockets.empty.own.body": "BOOST a rocket on the Launchpad and it shows up here.",
  "rockets.empty.own.cta": "Open Launchpad",
  "rockets.empty.other": (u: string) => `${u} isn't holding any rockets.`,

  // Loot (parts = cosmetic rewards of unlocked achievements; slot names follow the existing reward kinds)
  "loot.slot.skin": "Body skin",
  "loot.slot.trail": "Trail",
  "loot.slot.frame": "Frame",
  "loot.filter.all": (n: number) => `All ${n}`,
  "loot.popup.eyebrow": (rarity: string, slot: string) => `${rarity} · ${slot}`.toUpperCase(),
  "loot.popup.source.achievement": (a: string) => `Earned from ${a}`,
  "loot.popup.share.aria": "Share this part",
  "loot.popup.close.aria": "Close",
  "loot.popup.prev.aria": "Previous part",
  "loot.popup.next.aria": "Next part",
  "loot.popup.position": (i: number, n: number) => `${i} of ${n}`,
  "loot.cosmetic": "Cosmetic only — upgrades never change price, fills or odds.",
  "loot.empty.own.title": "No loot yet",
  "loot.empty.own.body": "Earn parts from achievements and prestige.",
  "loot.empty.own.cta": "See achievements",
  "loot.empty.other": (u: string) => `${u} hasn't found any loot yet.`,
  "loot.empty.slot": (slot: string) => `No ${slot.toLowerCase()} parts yet.`,

  // Achievements
  "ach.summary": (u: number, t: number) => `${u} of ${t} unlocked`,
  "ach.prestige": (n: number, name: string) => `Prestige ${n} · ${name}`,
  "ach.level": (l: number, max: number) => `Level ${l} of ${max}`,
  "ach.nextrank": (pts: string, next: string) => `${pts} pts to ${next}`,
  "ach.leaderboard": (rank: number) => `#${rank} on the leaderboard`,
  "ach.seeall": "See all achievements",
  "ach.empty.own": "No achievements yet. Your first BOOST starts the climb.",
  "ach.empty.other": (u: string) => `${u} hasn't unlocked any achievements yet.`,

  // Activity
  "activity.record": "Record",
  "activity.record.grads": "Graduations",
  "activity.pnl.title": "Cumulative PnL", // existed on the old profile; moved here as the one PnL chart
  "activity.empty.own": "Nothing here yet. BOOST a rocket and your war log starts.",
  "activity.empty.other": (u: string) => `No activity from ${u} yet.`,

  // Edit profile (modal / bottom sheet)
  "edit.title": "Edit profile",
  "edit.pfp.label": "Profile picture",
  "edit.pfp.upload": "Upload photo",
  "edit.pfp.change": "Change photo",
  "edit.pfp.remove": "Remove",
  "edit.pfp.helper": "Square works best. JPG, PNG or WebP, up to 2 MB.",
  "edit.username.label": "Username",
  "edit.username.checking": "Checking…",
  // Username: one change per 24h (lee 2026-10-24). `when` is the viewer's local date + time.
  "username.cooldown.note": (when: string) => `You can change your username again on ${when}.`,
  "username.cooldown.rule": "You can change your username once every 24 hours.",
  "username.cooldown.error": "You can change your username once every 24 hours.",
  "edit.bio.label": "Bio",
  "edit.bio.placeholder": "Who you fly for, what you hold, how you fight.",
  "edit.bio.helper": "Shown on your public profile.",
  "edit.bio.error.length": "Keep it to 160 characters.",
  "edit.bio.helper.links": "Emoji and links welcome. Links open in a new tab.",
  "edit.flag.label": "Country flag",
  "edit.flag.helper": "Optional. Shown next to your name.",
  "edit.flag.none": "No flag",
  "edit.flag.label.any": "Flag",
  "edit.flag.helper.any": "Optional. Your country or your coin community, shown next to your name.",
  "edit.flag.search": "Search flags",
  "edit.flag.section.community": "Communities",
  "edit.flag.section.country": "Countries",
  "edit.flag.empty": "No flags match.",
  "edit.flag.change": "Change",
  "edit.save": "Save",
  "edit.saving": "Saving…",
  "edit.saved": "Profile saved",
  "edit.sign": "Approve the signature to save your username.",
  "edit.error.save": "Couldn't save. Try again.",
  "edit.cancel": "Cancel",
  "edit.discard.title": "Discard changes?",
  "edit.discard.confirm": "Discard",
  "edit.discard.keep": "Keep editing",
} as const;

export type ProfileCopyKey = keyof typeof PROFILE_COPY;

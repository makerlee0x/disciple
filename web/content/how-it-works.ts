/**
 * /how-it-works copy (PLACEHOLDER, BRAND r1, Oct 17 2026). EVERY string the page renders lives in this one module, so copy
 * changes never touch layout code. Mirrors disciple-brand/mockups/how-it-works-r1/src/hiw_copy.py (the single copy source;
 * also copy/how-it-works-r1.md); labels the mock drew in build.py (diagram, sample flight card, chart axes) are at the end
 * of each section. Strings are verbatim from hiw_copy.py with BRAND's review chips ([C#]) and the DRAFT tags removed.
 *
 * Open items left as the mock has them (see `openItem` fields): C5 creator launch buy (not in /create yet), C10 footer
 * disclaimer, C11 "Can a creator rug?" FAQ, C12 difficulties are Simulator-only (linked to /flight/sim).
 */
import type { IconName } from "@/components/icons/Icon";

/** Real routes the CTAs go to. */
export const HIW_ROUTES = {
  launch: "/create",
  explore: "/",
  sim: "/flight/sim",
  simDifficulty: (id: "pve" | "pvp" | "trench") => `/flight/sim?difficulty=${id}`,
} as const;

export const HIW_META = {
  title: "How DISCIPLE works",
  description: "Every rocket is paired with a coin you believe in.",
};

/** Hero. The H1 renders one sentence per span; mobile stacks them ("Launch a rocket." / "Send your coin to the moon."). */
export const HIW_HERO = {
  eyebrow: "How it works",
  h1: "Launch a rocket. Send your coin to the moon.",
  sub: "Every rocket is paired with a coin you believe in.",
  ctas: { primary: "Launch a rocket", secondary: "Explore rockets" },
};

/** In-page nav under the hero (labels from the mock). */
export const HIW_SUBNAV = {
  label: "On this page",
  items: [
    { id: "pair", label: "How a pair works" },
    { id: "game", label: "How the game works" },
    { id: "phases", label: "Curve vs Uniswap" },
    { id: "modes", label: "Difficulties" },
    { id: "fees", label: "Fees" },
    { id: "faq", label: "FAQ" },
  ],
  docs: "Full docs: coming soon",
} as const;

export type HiwItem = { icon: IconName; title: string; body: string; openItem?: string };

/** 01 · How a pair works */
export const HIW_PAIR = {
  n: "01",
  eyebrow: "How a pair works",
  h2: "Every rocket has a base.",
  body: [
    "Pick a coin you believe in. That coin is the rocket’s base: the coin it’s paired with.",
    "Your rocket is a new coin, priced and traded in its base. BOOST it and you pay in the base. DUMP it and you’re paid in the base.",
    "At graduation, the base is seeded and locked permanently in the rocket’s Uniswap v4 liquidity.",
  ],
  diagram: {
    base: { title: "Base coin", desc: "A supported coin you believe in", value: "$USDG", coin: "G" },
    rocket: { title: "Rocket", desc: "A new coin, 7B supply, fixed", value: "$HALO", coin: "H", baseCoin: "G" },
    lp: { title: "Locked LP", desc: "Rocket + base, Uniswap v4, forever", value: "$HALO + $USDG" },
    arrows: ["priced & traded in", "at graduation, seeded into"],
    foot: [
      { icon: "boost", strong: "BOOST", text: " pays in the base" },
      { icon: "dump", strong: "DUMP", text: " pays out in the base" },
      { icon: "graduation", strong: "Graduation", text: " seeds the base into the locked LP" },
    ] as { icon: IconName; strong: string; text: string }[],
    sample: "SAMPLE · $HALO paired with USDG",
  },
  items: [
    { icon: "base-pair", title: "A supported base", body: "Pick a supported base: STRATEGY by default, USDG always. Other coins work once they have an on-chain USDG price pool." },
    { icon: "rocket", title: "A call sign", body: "Your $TICKER. A name, call sign and image are required. The name and call sign are set for good at launch." },
    { icon: "plus", title: "Four steps to the pad", body: "Name and call sign → image → pair with → launch. Anyone can launch. No permission needed." },
    { icon: "boost", title: "First BOOST is yours", body: "You can BOOST your own rocket in the launch transaction, up to 0.77% of supply.", openItem: "C5" },
  ] as HiwItem[],
};

/** 02 · How the game works. The BOOST = BUY · DUMP = SELL legend under the H2 is the shared TradeLegend (PR #85). */
export const HIW_GAME = {
  n: "02",
  eyebrow: "How the game works",
  h2: "BOOST to climb. DUMP drops a bomb.",
  body: [
    "Every rocket flies. Its altitude is its market cap, so higher is better.",
    "BOOSTs lift it. DUMPs drop bombs on it, live, for everyone aboard. A bomb’s size depends on how hard the sell moves the price, not on its dollar size.",
  ],
  caption: "Bomb size = price impact of the DUMP",
  tiers: [
    { id: "puff", name: "PUFF", range: "< 2%" },
    { id: "grenade", name: "GRENADE", range: "2–5%" },
    { id: "bunker", name: "BUNKER", range: "5–12%" },
    { id: "cruise", name: "CRUISE", range: "12–25%" },
    { id: "nuke", name: "NUKE", range: "25–50%" },
    { id: "atom", name: "ATOM", range: "≥ 50%" },
  ] as { id: "puff" | "grenade" | "bunker" | "cruise" | "nuke" | "atom"; name: string; range: string }[],
  tierUnit: "PRICE IMPACT",
  items: [
    { icon: "rocket", title: "Flight", body: "Open any rocket to fly it: the chart becomes the sky. Live altitude, BOOST and DUMP, bombs, and the top boosters (King of the Hill)." },
    { icon: "crew", title: "Crew", body: "Everyone who holds the rocket is aboard. Everyone aboard flies together, with crew chat in flight." },
    { icon: "achievement", title: "Achievements", body: "The Choir of Deeds: 43 badges in 8 categories. Earn rHALO points along the way." },
    { icon: "believer", title: "Identities", body: "Your playstyle earns a tag: Believer, Trencher, Sniper, Whale, Diamond Hands and more." },
  ] as HiwItem[],
  note: "Rocket upgrades are cosmetic only. They never change price, fills or odds.",
  /** Sample flight card (illustrative, mock data). */
  flight: {
    sample: "SAMPLE · $CHOIR",
    hudLabel: "ALTITUDE · MCAP",
    hudValue: "$402.0K",
    hudDelta: "▲ 12.9% · 24h",
    floaters: ["▲ BOOST +$420", "▲ BOOST +$1.2K"],
    bomb: "NUKE · −31%",
    aboard: "955 aboard",
    boost: "BOOST",
    dump: "DUMP",
    alt: "Sample flight: a rocket climbing through the sky, with BOOST and DUMP buttons and a bomb marker.",
  },
};

/** 03 · Bonding curve vs Uniswap */
export const HIW_PHASES = {
  n: "03",
  eyebrow: "Bonding curve vs Uniswap",
  h2: "Two phases. One rocket.",
  body: [
    "Every rocket starts on a bonding curve and graduates into a real Uniswap v4 pool. The switch happens in one transaction.",
  ],
  p1: { k: "Phase 1", title: "Bonding curve", body: "Price is set by a formula. Every BOOST and DUMP trades against the curve, and each coin sold costs a little more than the last." },
  p2: { k: "Phase 2", title: "Uniswap v4", body: "A real AMM pool: the rocket and its base. It opens at the curve’s last price: no jump, no pause." },
  link: "ONE TX",
  rows: [
    ["Price", "Set by the curve’s formula", "Set by the pool’s reserves"],
    ["You trade with", "The bonding curve", "The Uniswap v4 pool"],
    ["Market cap", "$7K → $33K", "$33K and up"],
    ["Supply", "72% sells on the curve", "The remaining 28% is seeded into the pool"],
    ["Liquidity", "Base builds up in the curve", "Full-range, owned by LockedLP, locked forever"],
    ["Fee", "1% (+ optional creator tax)", "1%, via the DISCIPLE hook"],
  ] as [string, string, string][],
  grad: "Graduation: at 72% sold and $33K, the same BOOST that crosses the line opens the pool.",
  after: "After graduation, 33% of every fee still goes to the locked liquidity, added to the position as it builds up.",
  chart: {
    title: "Bonding curve, then Uniswap v4: market cap against % of supply sold",
    start: "Start · $7K",
    grad: "Graduation · $33K · 72% sold",
    phase1: "PHASE 1 · BONDING CURVE",
    phase2: "PHASE 2 · UNISWAP V4 · LOCKED LP",
    phase2Note: "price set by the pool (illustrative)",
    xPhase1: "SUPPLY SOLD ON THE CURVE",
    xPhase2: "AFTER GRADUATION",
  },
};

/** 04 · Game difficulties (Simulator only; open item C12). Each card links to /flight/sim with its difficulty. */
export const HIW_MODES = {
  n: "04",
  eyebrow: "Game difficulties",
  h2: "Practice in the Simulator. Pick your war.",
  body: [
    "The Simulator is free paper trading on a private market. A fresh coin launches on the real curve ($7K → $33K) and bots trade it with you. You choose how hostile they are.",
  ],
  openItem: "C12",
  cards: [
    { id: "pve", title: "PvE", tag: "Crew", tone: "up", body: "Your crew helps the rocket climb. Bots buy dips and take modest profits. Low volatility, steady growth, an occasional small sell.", bots: "crew · diamond hands · scalpers · paper hands" },
    { id: "pvp", title: "PvP", tag: "Dog eat dog", tone: "secondary", body: "Every trader plays for their own PnL: momentum chasers, profit takers and whales. Bigger buys, bigger dumps. A high market cap is still possible.", bots: "momentum · scalpers · paper hands · whales · diamond hands · crew" },
    { id: "trench", title: "Trench Warfare", tag: "Mercenary", tone: "down", body: "Snipers buy the launch. Bundled wallets sit on supply. The dev may rug, and a community takeover might revive it. Huge swings: altitude is possible, but hard.", bots: "snipers · bundlers · dev · CTO · momentum · scalpers · paper hands" },
  ] as { id: "pve" | "pvp" | "trench"; title: string; tag: string; tone: "up" | "secondary" | "down"; body: string; bots: string }[],
  botsLabel: "BOTS",
  note: "Live rockets have no difficulty setting. The market is the market.",
  chartsNote: "Charts illustrative · paper money only",
  cta: "Open the Simulator",
};

/** 05 · Fees & creator rewards */
export const HIW_FEES = {
  n: "05",
  eyebrow: "Fees & creator rewards",
  h2: "One fee. Four places it goes.",
  body: [
    "Every BOOST and DUMP pays a 1% fee: 33% creator, 33% locked liquidity (added to the locked position as it builds up), 33% treasury, 1% referrer. After graduation the Uniswap pool charges no extra LP fee.",
  ],
  headline: { value: "1%", label: "of every BOOST and DUMP" },
  split: [
    { name: "Creator", pct: "33%", desc: "Builds up on-chain. Claim it anytime.", color: "#C9CED6" },
    { name: "Locked liquidity", pct: "33%", desc: "Set aside on every trade. Added to the locked position as it builds up.", color: "#8585AA" },
    { name: "Treasury", pct: "33%", desc: "Credited to the DISCIPLE treasury on every trade, then claimed.", color: "#44426A" },
    { name: "Referrer", pct: "1%", desc: "Goes to the launcher’s referrer first, if the launcher has one. 1% of the fee, not of the trade.", color: "#F2C14E" },
  ],
  example: "On a $100 BOOST, the fee is $1: $0.33 creator · $0.33 locked liquidity · $0.33 treasury · $0.01 referrer.",
  cards: [
    { title: "Creator tax", body: "Optional, 0–7%, set at launch and fixed. Charged on top of the 1% fee on bonding-curve trades only. After graduation, trades pay just the 1% fee.", more: "Creators can hand off a rocket anytime. The fee claim and tax rights go with it." },
    { title: "Anti-snipe", body: "For the first 7 seconds, the BOOST fee starts at 77.7% and drops to 0%. After that, only the 1% remains.", more: "70% of the snipe fee goes to a community rewards vault, to be shared out later (how is still being decided). 30% goes to the treasury. The creator’s launch buy is exempt.", openItem: "C5" },
    { title: "Referrals", body: "Share your link. When a wallet opens your link and deposits $10+ in USDG, it’s yours for life (first link wins).", more: "You earn 1% of the protocol fee on its trades, and on rockets it launches after that, 1% of the protocol fee on every trade plus 2% of the creator’s fee share. You can’t refer your own wallet." },
  ] as { title: string; body: string; more: string; openItem?: string }[],
  snipeChart: { title: "Anti-snipe BOOST fee over the first 7 seconds, stepping down from 77.7% to 0%", top: "77.7%", bottom: "0%", axis: "0s · anti-snipe fee, on top of the 1%", end: "7s" },
};

/** 06 · FAQ (accordion) */
export const HIW_FAQ = {
  n: "06",
  eyebrow: "FAQ",
  h2: "Questions, answered.",
  items: [
    { q: "Is the liquidity really locked?", a: "Yes. At graduation, the liquidity is locked forever in a full-range Uniswap v4 position owned by the LockedLP contract, which has no function to remove it. Contracts are non-upgradeable; admin controls are held by the team during testnet." },
    { q: "What coins can I pair with?", a: "Pick a supported base: STRATEGY by default, USDG always. Other coins work once they have an on-chain USDG price pool." },
    { q: "What does pairing do for my coin?", a: "Your rocket is priced and traded in its base. At graduation, the base is seeded and locked permanently in the rocket’s liquidity." },
    { q: "When does a rocket graduate?", a: "At a $33K market cap, when 72% of supply has sold on the bonding curve. It moves to Uniswap v4 in the same transaction." },
    { q: "What are the fees?", a: "1% on every BOOST and DUMP: 33% creator, 33% locked liquidity, 33% treasury, 1% referrer. Creators can add a 0–7% tax on bonding-curve trades, set at launch. An anti-snipe fee applies only in the first 7 seconds." },
    { q: "Can a creator rug?", a: "There’s no further mint, the name and ticker are set at launch, and graduated liquidity has no withdraw function. Creators can still sell their own coins, like anyone else.", openItem: "C11" },
    { q: "What is the Simulator?", a: "Free paper trading against bots on a private market, with no wallet and no transactions. Pick PvE, PvP or Trench Warfare.", openItem: "C12" },
    { q: "Is DISCIPLE audited?", a: "Not yet. The contracts have had internal security reviews only, no third-party audit. A professional audit is required before mainnet." },
    { q: "Is this live?", a: "DISCIPLE runs on Robinhood Chain Testnet today, with test tokens. Mainnet isn’t live yet, and there’s no date." },
    { q: "What do I need to start?", a: "Sign in with X or a wallet. Deposits are USDG on Robinhood Chain, and you pay your own gas." },
  ] as { q: string; a: string; openItem?: string }[],
};

/** Final CTA + footer. The footer disclaimer is open item C10 (pending legal review). */
export const HIW_FINAL = {
  h2: "To the moon.",
  sub: "Pick a coin you believe in. Launch a rocket paired with it.",
  ctas: { primary: "Launch a rocket", secondary: "Explore rockets" },
  link: "Full docs: coming soon",
  footer: "Robinhood Chain Testnet · Not audited · Nothing here is financial advice.",
  footerOpenItem: "C10",
  logoAlt: "DISCIPLE",
};

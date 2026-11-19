/**
 * /how-it-works ("How to play") copy. Every string the page renders lives here, so copy changes never touch layout.
 * Two tabs (canvas boards "How to play: Pilot tab" and "How to play: Pro tab"): Pilot is a first-flight tutorial built on
 * an annotated flight screen; Pro is a spec sheet of the contract numbers (contracts/src/libraries/Constants.sol) for
 * traders. Full rules live in the docs.
 */

export const HIW_ROUTES = {
  launch: "/create",
  explore: "/",
  sim: "/flight/sim",
  docs: "/docs",
  contracts: "/docs/reference/contracts",
} as const;

export const HIW_META = {
  title: "How to play · DISCIPLE",
  description: "Multiplayer memecoins and 1v1 trading duels. Launch your own coin with a crew, or take on another trader for one minute.",
};

/** Mode tabs (maker 2026-11-18: "a tab for each game mode so people can see all the different modes"). #duel / #climb open those. */
export type HiwMode = "launch" | "duel" | "climb";
export const HIW_TABS = { label: "Game mode", pilot: "Pilot", pro: "Pro" } as const;
export const HIW_H1 = "How to play";

/** A step in the 3-step strip. `art` picks the little drawing above it (page.tsx Art). Titles are verbs; lines stay under
 *  ten words (show, don't tell: the drawing carries the idea). */
export type HiwStep = { art: string; title: string; line: string };
export type HiwGame = {
  id: HiwMode; tab: string; tag: string; art: string; tone: string;
  steps: HiwStep[];
  win: { ok: string; bad: string };
  /** each key is [key, what it does]; the caption sits under the key */
  keys: { k: string; keys: [string, string][]; tone: "up" | "down" | "gold" }[];
  cta: { label: string; href: string };
};

export const HIW_GAMES: HiwGame[] = [
  {
    id: "launch", tab: "Launch", tag: "Your own coin", art: "/art/modes/launch.webp", tone: "#F3DFA8",
    steps: [
      { art: "board", title: "Boost", line: "Buy on the bonding curve. Early is cheap." },
      { art: "climb", title: "Climb", line: "Every buy pumps the mcap. $33.3K is Orbit." },
      { art: "cash", title: "Dump", line: "Sell any time. Take profit or take the L." },
    ],
    win: { ok: "Sell above your entry", bad: "Sell below it and you eat the loss" },
    keys: [
      { k: "Boost", keys: [["1", "$10"], ["2", "$25"], ["3", "$50"], ["4", "$100"], ["Space", "Buy"]], tone: "up" },
      { k: "Dump", keys: [["Z", "10%"], ["X", "25%"], ["C", "50%"], ["V", "100%"], ["Shift", "Sell"]], tone: "down" },
    ],
    cta: { label: "Find a flight", href: "/live" },
  },
  {
    id: "duel", tab: "Duel", tag: "1v1", art: "/art/modes/duel.webp", tone: "#FF9CC4",
    steps: [
      { art: "versus", title: "1v1 on BTC", line: "Same coin, same fuel, one minute." },
      { art: "call", title: "Long or short", line: "Boost to long. Dump to short. Leverage on." },
      { art: "clock", title: "Out-PnL them", line: "Bigger PnL at the bell wins." },
    ],
    win: { ok: "More PnL than your rival", bad: "Less PnL, or you get liquidated" },
    keys: [
      { k: "Boost", keys: [["Space", "Long"]], tone: "up" },
      { k: "Dump", keys: [["Shift", "Short"]], tone: "down" },
      { k: "Cash out", keys: [["Enter", "Close"]], tone: "gold" },
    ],
    cta: { label: "Play a duel", href: "/turbo/duel" },
  },
  {
    id: "climb", tab: "Climb", tag: "Solo", art: "/art/modes/live.webp", tone: "#5FF0A0",
    steps: [
      { art: "level", title: "Pick a level", line: "Each level sets your fuel and leverage." },
      { art: "target", title: "Hit the target", line: "Make the % before the minute ends." },
      { art: "ladder", title: "Level up", line: "Clear 5 levels to unlock free mode." },
    ],
    win: { ok: "Hit the target in time", bad: "Miss it or get liquidated" },
    keys: [
      { k: "Boost", keys: [["Space", "Long"]], tone: "up" },
      { k: "Dump", keys: [["Shift", "Short"]], tone: "down" },
      { k: "Cash out", keys: [["Enter", "Close"]], tone: "gold" },
    ],
    cta: { label: "Play Climb", href: "/turbo/climb" },
  },
];

/** Launch only: the three difficulties a host picks (caps in contracts/src/libraries/Constants.sol). The max bag grows with
 *  mcap and only holds on the bonding curve; it lifts at Orbit (maker 2026-11-18: "that's important for people to know"). */
export const HIW_DIFFS = [
  { id: "easy", badge: "Easy", stat: "Max bag 1% → 3.33%" },
  { id: "hard", badge: "Hard", stat: "Max bag 3.33% → 7.77%" },
  { id: "expert", badge: "Expert", stat: "No cap" },
];
export const HIW_DIFFS_TAG = "Bonding curve only · lifts at Orbit";
export const HIW_ORBIT = { k: "Orbit", v: "$33,333", line: "The crew's goal. The rocket lists for good." };
export const HIW_HOST = { text: "Hosts earn 0.33% of every trade.", link: "Launch one" };

export const HIW_PRO = {
  eyebrow: "",
  h1: "Spec sheet",
  sub: "",
  market: {
    title: "Market",
    rows: [
      ["Chain", "Robinhood Chain"],
      ["Supply", "1,000,000 · fixed, no mint"],
      ["Pair coins", "12 to pick from · STRATEGY default"],
      ["Curve start", "$3,333 mcap"],
      ["Orbit (graduation)", "$33,333 mcap · 84.24% sold"],
      ["After orbit", "Uniswap v4 · LP locked forever"],
      ["Into the locked LP", "15.76% of supply + base"],
    ] as [string, string][],
  },
  fees: {
    title: "Fees",
    rows: [
      ["Trade fee", "1% on every buy and sell"],
      ["Fee split", "33 host · 33 LP · 33 treasury · 1 referrer"],
      ["Host tax", "0–7%, set at launch, curve only"],
      ["Anti-snipe", "99% → 0 over the first 7s"],
      ["Anti-snipe proceeds", "To the LP at orbit, else the rewards vault at 12 days"],
      ["After orbit", "1%, no host tax"],
      ["Slippage presets", "5 · 15 · 30 · 50%"],
    ] as [string, string][],
  },
  modes: {
    title: "Difficulty rules (curve only, off at orbit)",
    cols: ["Easy", "Hard", "Expert"],
    rows: [
      ["Hold cap per wallet", "1% → 3.33%", "3.33% → 7.77%", "None"],
      ["Host first buy, max", "1.2% · locked to orbit", "3.33%", "7.77%"],
      ["Crew tip", "0.777% of big winning sells, paid to holders", "—", "—"],
    ] as [string, string, string, string][],
    overcap: ["Over-cap buys", "Partial fill, unused input refunded. No max buy or sell."] as [string, string],
  },
  /** shown only when PRO_HUD_ENABLED (the Pro trader view is hidden for launch) */
  hud: {
    title: "Pro HUD",
    rows: [
      ["Chart", "Live candles, 5-min momentum"],
      ["Holders", "Count + top-10 share"],
      ["Orbit", "Distance to $33,333"],
      ["Your room", "Hold cap left, net dump value"],
      ["Order preview", "Fee + slippage before you fire"],
      ["Feed", "All · Trades · Chat · Holders"],
    ] as [string, string][],
  },
  keys: {
    title: "Hotkeys",
    rows: [
      { k: "Buy size", keys: ["1", "2", "3", "4"], v: "$10 · $25 · $50 · $100" },
      { k: "Buy", keys: ["Space"], v: "" },
      { k: "Sell size", keys: ["Z", "X", "C", "V"], v: "10 · 25 · 50 · 100%" },
      { k: "Sell", keys: ["Shift"], v: "" },
      { k: "Custom boost", keys: [], v: "Type any $ amount" },
    ] as { k: string; keys: string[]; v: string }[],
  },
  verify: { title: "Verify it yourself", body: "Contracts, curve math and full rules.", contracts: "Contracts", docs: "Read the docs" },
};

export const HIW_FINAL = {
  h2: "Ready up",
  /** the Pilot / Pro switch again, so a reader at the bottom can flip modes without scrolling back up */
  tog: "Read it as",
  sim: "Try Free play",
  explore: "Find a flight",
  launch: "Launch a rocket",
  logoAlt: "DISCIPLE",
};

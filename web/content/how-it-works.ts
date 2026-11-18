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

export const HIW_TABS = { label: "Mode", pilot: "Pilot", pro: "Pro" } as const;

export const HIW_PILOT = {
  eyebrow: "",
  h1: "Your first flight",
  sub: "Seats cost real cash.",
  /** The annotated flight screen: an illustration of the HUD, not live data. */
  screen: {
    tag: "Example",
    altitude: { k: "Altitude · Stratosphere", v: "$18.4K", orbit: "Orbit in $14.9K", fill: 0.45 },
    bag: { k: "Your bag", v: "$62.40", put: "Put in $50.00", gain: "+$12.40" },
    boost: "▲ +$25 · ACE",
    bomb: "● Bunker buster −3%",
    buys: [["1", "$10"], ["2", "$25"], ["3", "$50"], ["4", "$100"]] as [string, string][],
    sells: [["Z", "10%"], ["X", "25%"], ["C", "Half"], ["V", "All"]] as [string, string][],
    boostBtn: "▲ Boost $25",
    dumpBtn: "▼ Dump ~$15",
    alt: "The flight screen: altitude top left, your bag top right, a bomb marker, and the boost and dump bar along the bottom.",
  },
  legend: [
    { title: "Altitude", body: "Market cap, and how far to orbit." },
    { title: "Your bag", body: "What you'd get out now vs. what you put in." },
    { title: "Bombs", body: "Someone dumped. Bigger dump, bigger blast." },
    { title: "Boost", body: "1–4 sets the size. Space buys in." },
    { title: "Dump", body: "Z X C V sets how much. Shift cashes out." },
  ],
  phone: "Phone: throttle up to boost, down to dump.",
  rules: {
    eyebrow: "",
    h2: "How you win",
    cards: [
      { id: "win", k: "Win", title: "Cash out higher", body: "Dump above your entry. Profit lands as cash." },
      { id: "lose", k: "Lose", title: "Ride it down", body: "Below your entry, you're down. Only fly what you can lose." },
      { id: "goal", k: "Crew goal", title: "Reach orbit", body: "$33,333 market cap. Everyone aboard sees it." },
    ],
  },
  modes: [
    { id: "easy", badge: "Easy", title: "Co-op", body: "Tight caps" },
    { id: "hard", badge: "Hard", title: "Free for all", body: "Loose caps" },
    { id: "expert", badge: "Expert", title: "The trenches", body: "No caps" },
  ],
  host: { text: "Hosts earn a cut of every trade.", link: "Launch one" },
};

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
  sub: "Free play uses practice cash.",
  /** the Pilot / Pro switch again, so a reader at the bottom can flip modes without scrolling back up */
  tog: "Read it as",
  sim: "Try Free play",
  explore: "Find a flight",
  launch: "Launch a rocket",
  footer: "DISCIPLE runs on Robinhood Chain. Nothing here is financial advice.",
  logoAlt: "DISCIPLE",
};

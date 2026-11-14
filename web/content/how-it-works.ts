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
  description: "Boost a rocket with your crew, dodge the bombs and cash out higher than you got in.",
};

export const HIW_TABS = { label: "Mode", pilot: "Pilot", pro: "Pro" } as const;

export const HIW_PILOT = {
  eyebrow: "How to play",
  h1: "Your first flight",
  sub: "Seats cost real cash. Cash out for more than you paid in, and you win.",
  /** The annotated flight screen: an illustration of the HUD, not live data. */
  screen: {
    tag: "Example",
    altitude: { k: "Altitude · Stratosphere", v: "$18.4K", orbit: "Orbit in $14.9K", fill: 0.45 },
    bag: { k: "Your bag", v: "$62.40", put: "Put in $50.00", gain: "+$12.40" },
    boost: "▲ +$25 · Nova",
    bomb: "● Grenade −3%",
    buys: [["1", "$10"], ["2", "$25"], ["3", "$50"], ["4", "$100"]] as [string, string][],
    sells: [["Z", "10%"], ["X", "25%"], ["C", "Half"], ["V", "All"]] as [string, string][],
    boostBtn: "▲ Boost $25",
    dumpBtn: "▼ Dump ~$15",
    alt: "The flight screen: altitude top left, your bag top right, a bomb marker, and the boost and dump bar along the bottom.",
  },
  legend: [
    { title: "Altitude", body: "What the rocket is worth right now, and how far it is from orbit." },
    { title: "Your bag", body: "What your seat would pay out if you dumped now, next to what you put in." },
    { title: "Bombs", body: "Someone dumped. The bigger the drop, the bigger the blast." },
    { title: "Boost", body: "Pick an amount with 1 to 4, then hit Space. Your cash buys a seat and lifts the rocket." },
    { title: "Dump", body: "Pick how much with Z, X, C or V, then hit Shift. You get cash back and drop a bomb." },
  ],
  phone: "On a phone, slide the throttle up to boost and down to dump.",
  rules: {
    eyebrow: "The rules",
    h2: "How you win",
    cards: [
      { id: "win", k: "Win", title: "Cash out higher", body: "Dump when your bag is worth more than you put in. The gain is yours, in cash." },
      { id: "lose", k: "Lose", title: "Ride it down", body: "If the rocket falls below where you boarded, your bag is worth less than you paid. Only fly with cash you’re fine losing." },
      { id: "goal", k: "Crew goal", title: "Reach orbit", body: "At $33,333 the rocket breaks into orbit and the sky opens up. Everyone aboard gets the moment." },
    ],
  },
  modes: [
    { id: "easy", badge: "Easy", title: "Co-op", body: "Nobody can hog the rocket" },
    { id: "hard", badge: "Hard", title: "Free for all", body: "Bigger seats, bigger swings" },
    { id: "expert", badge: "Expert", title: "The trenches", body: "No limits, anything goes" },
  ],
  host: { text: "Want to host? Launch your own rocket and you earn a cut of every boost and dump on it.", link: "Start a launch" },
};

export const HIW_PRO = {
  eyebrow: "How to play",
  h1: "Spec sheet",
  sub: "Every number a trader checks before sizing in, straight from the contracts.",
  market: {
    title: "Market",
    rows: [
      ["Chain", "Robinhood Chain"],
      ["Supply", "1,000,000 · fixed, no mint"],
      ["Quoted in", "USDG or STRATEGY"],
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
      { k: "Custom size", keys: [], v: "Type any $ or %" },
    ] as { k: string; keys: string[]; v: string }[],
  },
  verify: { title: "Verify it yourself", body: "The contracts, the curve formula and the full rules are in the docs.", contracts: "Contracts", docs: "Read the docs" },
};

export const HIW_FINAL = {
  h2: "Ready up",
  sub: "Warm up in Free play with practice cash, or jump into a live flight.",
  /** the Pilot / Pro switch again, so a reader at the bottom can flip modes without scrolling back up */
  tog: "Read it as",
  sim: "Try Free play",
  explore: "Find a flight",
  launch: "Launch a rocket",
  footer: "DISCIPLE runs on Robinhood Chain. Nothing here is financial advice.",
  logoAlt: "DISCIPLE",
};

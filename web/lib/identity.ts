/**
 * CT-native identity labels derived from player metrics.
 * Thresholds live in config IDENTITY_THRESHOLDS.
 */
import { IDENTITY_THRESHOLDS } from "./config";
import type { IdentityMetrics } from "./stats";

export type IdentityId =
  | "believer"
  | "trencher"
  | "sniper"
  | "diamond_hands"
  | "paper_hands"
  | "exit_liquidity"
  | "whale"
  | "degen"
  | "bag_holder"
  | "jeet"
  | "bomber"
  | "nuker"
  | "crew_captain"
  | "gate_keeper"
  | "dev_supporter"
  | "launcher"
  | "kingmaker"
  | "farmer"
  | "smart_money";

export interface IdentityDef {
  id: IdentityId;
  label: string;
  blurb: string;
  weight: number;
  test: (m: IdentityMetrics) => boolean;
}

const T = IDENTITY_THRESHOLDS;

export const IDENTITIES: readonly IdentityDef[] = [
  { id: "nuker", label: "Nuker", blurb: "Dropped nukes / atom bombs — the sky went dark.", weight: 95,
    test: (m) => m.nukeCount >= T.nukerMinNukes },
  { id: "bomber", label: "Bomber", blurb: "Lives for impact. Grenades and worse.", weight: 90,
    test: (m) => m.bombCount >= T.bomberMinBombs },
  { id: "smart_money", label: "Smart Money", blurb: "Top-decile ROI with enough closes to prove it.", weight: 88,
    test: (m) => m.roiPercentile >= T.smartMoneyRoiDecile && m.closedTrades >= T.smartMoneyMinTrades },
  { id: "kingmaker", label: "Kingmaker", blurb: "Early boosts on rockets that punched into Morning Stars+.", weight: 85,
    test: (m) => m.kingmakerCount >= T.kingmakerCount },
  { id: "crew_captain", label: "Crew Captain", blurb: "Top booster on rockets that graduated.", weight: 84,
    test: (m) => m.crewCaptainGrads >= T.crewCaptainGradTop },
  { id: "gate_keeper", label: "Gate Keeper", blurb: "Helped shove rockets into Outer Space.", weight: 83,
    test: (m) => m.gateKeeperAssists >= T.gateKeeperAssists },
  { id: "diamond_hands", label: "Diamond Hands", blurb: "Held through a −50% drawdown and still aboard.", weight: 80,
    test: (m) => m.diamondHandsCount >= 1 },
  { id: "believer", label: "Believer", blurb: "Long holds. Rides drawdowns with the crew.", weight: 86,
    test: (m) => m.avgHoldHours >= T.believerHoldHours && (m.heldThroughDrawdownFrac > 0 || m.diamondHandsCount >= 1) },
  { id: "sniper", label: "Sniper", blurb: "Buys in the first blocks after launch.", weight: 78,
    test: (m) => m.sniperBuyFraction >= T.sniperBuyFraction && m.buyCount >= 5 },
  { id: "whale", label: "Whale", blurb: "Top 1% by size. The tank that moves the rocket.", weight: 82,
    test: (m) => m.sizePercentile >= T.whaleSizePercentile },
  { id: "launcher", label: "Launcher", blurb: "Lit the pad. Rockets with your name on the nose.", weight: 70,
    test: (m) => m.launches >= T.launcherMinLaunches },
  { id: "dev_supporter", label: "Dev Supporter", blurb: "Launched rockets that actually graduated.", weight: 72,
    test: (m) => m.graduatedLaunches >= T.launcherGraduated },
  { id: "trencher", label: "Trencher", blurb: "Seconds in, seconds out. High trade count.", weight: 96,
    test: (m) => m.avgHoldHours * 60 <= T.trencherHoldMinutes && m.tradeCount >= T.trencherMinTrades },
  { id: "degen", label: "Degen", blurb: "High frequency across many different rockets.", weight: 68,
    test: (m) => m.distinctRockets >= T.degenMinRockets && m.tradeCount >= T.degenMinTrades },
  { id: "jeet", label: "Jeet", blurb: "Dumps right after a pump. Take the W and bounce.", weight: 60,
    test: (m) => m.jeetCount >= 3 },
  { id: "paper_hands", label: "Paper Hands", blurb: "Sells within minutes on small dips.", weight: 55,
    test: (m) => m.paperHandsCount >= 5 },
  { id: "exit_liquidity", label: "Exit Liquidity", blurb: "Buys tops, then watches the drawdown.", weight: 58,
    test: (m) => m.exitLiqEvents >= T.exitLiqMinEvents },
  { id: "bag_holder", label: "Bag Holder", blurb: "Big unrealized hole, still holding.", weight: 50,
    test: (m) => m.openUpnlLossFrac >= T.bagHolderUpnlLoss && m.openHoldHours >= T.bagHolderHoldHours },
  { id: "farmer", label: "Farmer", blurb: "Stacks rHALO while PnL stays humble.", weight: 45,
    test: (m) => m.points >= T.farmerMinPoints && m.realizedPnl <= T.farmerMaxPnl },
] as const;

export interface DerivedIdentity {
  primary: IdentityDef;
  secondary: IdentityDef[];
  matched: IdentityDef[];
}

export function deriveIdentity(m: IdentityMetrics): DerivedIdentity {
  const matched = IDENTITIES.filter((d) => d.test(m)).sort((a, b) => b.weight - a.weight);
  if (matched.length === 0) {
    const fallback: IdentityDef = {
      id: "believer", label: "Normie", blurb: "Still finding the flight path.", weight: 0, test: () => true,
    };
    return { primary: fallback, secondary: [], matched: [] };
  }
  return { primary: matched[0], secondary: matched.slice(1, 4), matched };
}

export function identityRuleText(id: IdentityId): string {
  switch (id) {
    case "believer": return `Avg hold ≥ ${T.believerHoldHours}h and held through ≥${T.believerDrawdownHold * 100}% drawdown`;
    case "trencher": return `Avg hold ≤ ${T.trencherHoldMinutes}m and ≥ ${T.trencherMinTrades} trades`;
    case "sniper": return `≥ ${T.sniperBuyFraction * 100}% of buys within ${T.sniperEntrySec}s of launch`;
    case "diamond_hands": return `Held through ≥ ${T.diamondDrawdown * 100}% drawdown while still open`;
    case "paper_hands": return `≥5 sells within ${T.paperHandsSellMinutes}m on ≤${T.paperHandsDip * 100}% dips`;
    case "exit_liquidity": return `≥ ${T.exitLiqMinEvents} buys near local high then ≥${T.exitLiqDrawdown * 100}% drawdown`;
    case "whale": return `Top ${(1 - T.whaleSizePercentile) * 100}% by position size`;
    case "degen": return `≥ ${T.degenMinRockets} rockets and ≥ ${T.degenMinTrades} trades`;
    case "bag_holder": return `Open uPnL ≤ −${T.bagHolderUpnlLoss * 100}% for ≥ ${T.bagHolderHoldHours}h`;
    case "jeet": return `≥3 dumps within ${T.jeetDumpMinutes}m after ≥${T.jeetPumpMultiple}× pump`;
    case "bomber": return `≥ ${T.bomberMinBombs} bombs (impact ≥ grenade)`;
    case "nuker": return `≥ ${T.nukerMinNukes} nukes/atoms (impact ≥ 25%)`;
    case "crew_captain": return `Top booster on ≥ ${T.crewCaptainGradTop} graduated rockets`;
    case "gate_keeper": return `≥ ${T.gateKeeperAssists} Outer Space assists`;
    case "launcher": return `≥ ${T.launcherMinLaunches} rocket launched`;
    case "dev_supporter": return `≥ ${T.launcherGraduated} graduated launch`;
    case "kingmaker": return `Early boosts on ≥ ${T.kingmakerCount} rockets that hit Morning Stars+`;
    case "farmer": return `≥ ${T.farmerMinPoints} points with realized PnL ≤ $${T.farmerMaxPnl}`;
    case "smart_money": return `Top ${(1 - T.smartMoneyRoiDecile) * 100}% ROI with ≥ ${T.smartMoneyMinTrades} closes`;
    default: return "";
  }
}

/** The ONE playstyle badge shown on a profile — earned from behavior, never user-switchable. */
export type PersonaBadgeId = "believer" | "trencher" | "bomber";
export const PERSONA_BADGES: Record<PersonaBadgeId, { label: string; blurb: string; icon: string }> = {
  believer: { label: "Believer", blurb: "Long holds. Rides drawdowns with the crew.", icon: "/achievements/believer_badge.svg" },
  trencher: { label: "Trencher", blurb: "Seconds in, seconds out. High trade count.", icon: "/achievements/trench_warfare.svg" },
  bomber: { label: "Bomber", blurb: "Lives for impact. Grenades and worse.", icon: "/achievements/carpet_bomber.svg" },
};
export function personaBadge(d: DerivedIdentity): PersonaBadgeId {
  const ids = d.matched.map((m) => m.id);
  const pick = ids.find((id) => id === "bomber" || id === "nuker" || id === "trencher" || id === "believer");
  if (pick === "nuker" || pick === "bomber") return "bomber";
  if (pick === "trencher") return "trencher";
  return "believer";
}

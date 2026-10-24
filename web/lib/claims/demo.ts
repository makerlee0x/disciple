/**
 * SAMPLE data for the claim screens (screenshots / design review). Only active with ?demo=1 AND (dev build or
 * NEXT_PUBLIC_CLAIMS_DEMO=1). Always rendered under a visible "SAMPLE DATA" tag; never mixed with live rows.
 */
import type { Address, Hex } from "viem";
import type { Caps } from "./capabilities";
import type { CreatorRocket } from "./creatorFees";
import { usdgDecimals, usdToUsdgRaw } from "../usdg";
import type { Asset } from "./common";
import { groupHistory, summarize, type RewardEntry } from "./rewards";
import type { RewardsData } from "./rewardsData";

export function demoEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const allowed = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_CLAIMS_DEMO === "1";
  return allowed && new URLSearchParams(window.location.search).get("demo") === "1";
}
/** v4: every claim card is live, so the demo always previews them all (kept as a function for callers). */
export const demoRedeploy = () => demoEnabled();

const E18 = BigInt(10) ** BigInt(18);
const STRAT: Asset = { address: "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3", symbol: "STRATEGY", decimals: 18, usd: 0.00245 };
const USDG: Asset = { address: "0x25030Bff74764aD72b912276a603717DB1C00644", symbol: "mUSDG", decimals: usdgDecimals(), usd: 1 };
const tx = (n: number) => (`0x${n.toString(16).padStart(64, "a")}`) as Hex;
const who = (n: number) => (`0x${n.toString(16).padStart(40, "7")}`) as Address;
const r = (x: number) => BigInt(Math.round(x * 1e6)) * (E18 / BigInt(1e6));
/** USDG demo amounts at the configured usdgDecimals (18 today, 6 after the redeploy). */
const ru = (x: number) => usdToUsdgRaw(x);

export const DEMO_CAPS = (redeploy: boolean): Caps => ({ creatorFees: true, referrerFees: true, creatorTokenFees: redeploy, crew: redeploy, referralGate: redeploy, anonClaims: true });

export function demoRockets(redeploy: boolean): CreatorRocket[] {
  const rows: CreatorRocket[] = [
    { token: "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3", name: "Smoke Test", ticker: "SMOKE", quote: STRAT,
      claimable: r(18_420.5), claimed: r(52_000), lifetime: r(70_420.5),
      recent: [1, 2, 3, 4].map((i) => ({ amount: r(1200 / i), trader: who(i), tx: tx(i), block: BigInt(137_900_000 - i * 40), side: "quote" as const })), tokenSide: null },
    { token: "0x000000000000000000000000000000000000d302", name: "Halo Drive", ticker: "HALO", quote: USDG,
      claimable: ru(42.17), claimed: ru(110.4), lifetime: ru(152.57),
      recent: [5, 6].map((i) => ({ amount: ru(3.2 * i), trader: who(i), tx: tx(i), block: BigInt(137_800_000 - i * 40), side: "quote" as const })), tokenSide: null },
    { token: "0x000000000000000000000000000000000000d303", name: "Quiet Orbit", ticker: "QRB", quote: STRAT,
      claimable: BigInt(0), claimed: r(900), lifetime: r(900), recent: [], tokenSide: null },
  ];
  if (redeploy) rows[0].tokenSide = { asset: { address: rows[0].token, symbol: "SMOKE", decimals: 18, usd: 0.0000049 }, claimable: r(1_250_000), claimed: r(400_000) };
  if (redeploy) rows.push({ token: "0x000000000000000000000000000000000000d304", name: "Night Shift", ticker: "NITE", quote: STRAT, anon: true,
    claimable: r(2_640), claimed: BigInt(0), lifetime: r(2_640), recent: [],
    tokenSide: { asset: { address: "0x000000000000000000000000000000000000d304", symbol: "NITE", decimals: 18, usd: null }, claimable: BigInt(0), claimed: BigInt(0) },
    tokenUnclaimable: { asset: { address: "0x000000000000000000000000000000000000d304", symbol: "NITE", decimals: 18, usd: null }, raw: r(84_000) } });
  return rows;
}
export const demoReferral = () => [{ asset: STRAT, claimable: r(3_100) }, { asset: USDG, claimable: ru(1.84) }];
export const demoCrew = () => [{ token: "0xcac8A9654dE3aE01470fC9E93e58fb97d5B86bb3" as Address, ticker: "SMOKE", name: "Smoke Test", quote: STRAT, pending: r(640.25) }];
export const demoGate = (nowSec: number) => ({
  status: "pending" as const, referrer: "0x7777777777777777777777777777777777777777" as Address, usdg: USDG, min: ru(10), gate: ru(10), lockSec: 7 * 86400, deposited: ru(0), balance: ru(25),
  escrows: [{ id: 1, amount: ru(10), unlockAt: nowSec + 3 * 86400 + 4 * 3600 }, { id: 0, amount: ru(10), unlockAt: nowSec - 3600 }],
});
export const demoFeed = () => [
  { seller: who(9), tax: r(77.7), grossQuote: r(10_000), tx: tx(9), block: BigInt(1) },
  { seller: who(8), tax: r(12.4), grossQuote: r(1_600), tx: tx(8), block: BigInt(1) },
];

/** SAMPLE combined rewards (profile Rewards section, ?demo=1 on dev builds only). Built with the same sums as live. */
export function demoRewards(nowSec: number): RewardsData {
  const h = 3600, d = 86400;
  const entries: RewardEntry[] = [
    { kind: "referral", ts: nowSec - 5 * h, usd: 44.87 }, { kind: "creator", ts: nowSec - 7 * h, usd: 12.4 },
    { kind: "referral", ts: nowSec - d - 2 * h, usd: 57.87 }, { kind: "crew", ts: nowSec - 2 * d, usd: 1.57 },
    { kind: "referral", ts: nowSec - 3 * d, usd: 11.35 }, { kind: "creator", ts: nowSec - 9 * d, usd: 30.2 },
    { kind: "referral", ts: nowSec - 12 * d, usd: 80.04 },
  ];
  const claimable = [{ kind: "referral" as const, usd: 21.43 }, { kind: "creator" as const, usd: 45.12 }, { kind: "crew" as const, usd: 1.57 }];
  const claimed = [{ kind: "referral" as const, usd: 172.7 }, { kind: "creator" as const, usd: 42.6 }, { kind: "crew" as const, usd: 1.57 }];
  const summary = summarize(claimable, claimed, entries, nowSec);
  return {
    summary, history: groupHistory(entries),
    claimableByKind: { referral: 21.43, creator: 45.12, crew: 1.57 },
    claim: { referral: demoReferral(), creator: demoRockets(true).filter((x) => x.claimable > BigInt(0)), crew: demoCrew().map((c) => ({ token: c.token, pending: c.pending })) },
    launched: 4, referralPaused: false,
  };
}

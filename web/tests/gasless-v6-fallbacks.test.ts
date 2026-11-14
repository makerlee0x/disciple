/** Testnet (46630) fallbacks and private-launch add-ons point at the v6 stack (contracts/deployments/rh-testnet-46630.json). */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEPLOYMENTS } from "../lib/chains";
import { ANON_ADDONS, anonLaunchers, isLegacyLauncher } from "../lib/anon";

const json = JSON.parse(readFileSync(new URL("../../contracts/deployments/rh-testnet-46630.json", import.meta.url), "utf8")) as { id: string; contracts: Record<string, string>; tokens: Record<string, { address: string }>; legacyAnonLaunchers: string[] };
const lc = (a: string) => a.toLowerCase();
const envSet = (k: string) => !!process.env[`NEXT_PUBLIC_RHT_${k}`];

describe("v6 testnet fallbacks", () => {
  it("deployments json is v6", () => { expect(json.id).toBe("v6"); });
  const d = DEPLOYMENTS[46630];
  const rows: [keyof typeof d, string, string][] = [
    ["launchpad", "Launchpad", "LAUNCHPAD"], ["hook", "DiscipleHook", "HOOK"], ["router", "DiscipleRouter", "ROUTER"],
    ["gaslessRouter", "DiscipleRouter", "GASLESS_ROUTER"], ["feeRouter", "FeeRouter", "FEE_ROUTER"],
    ["referralRegistry", "ReferralRegistry", "REFERRAL_REGISTRY"], ["lockedLP", "LockedLP", "LOCKED_LP"],
    ["quotePricer", "QuotePricer", "QUOTE_PRICER"], ["quoteProbe", "QuoteProbe", "QUOTE_PROBE"], ["migration", "Migration", "MIGRATION"],
    ["trampWallManager", "TrampWallManager", "TRAMP_WALL_MANAGER"], ["marketLens", "MarketLens", "MARKET_LENS"],
    ["loginGate", "LoginGate", "LOGIN_GATE"], ["usdgDepositNotifier", "UsdgDepositNotifier", "USDG_DEPOSIT_NOTIFIER"],
  ];
  for (const [field, name, env] of rows) {
    it.skipIf(envSet(env))(`${String(field)} = v6 ${name}`, () => { expect(lc(String(d[field]))).toBe(lc(json.contracts[name])); });
  }
  it.skipIf(envSet("USDG") || envSet("DEFAULT_QUOTE"))("USDG / STRATEGY unchanged", () => {
    expect(lc(d.usdg)).toBe(lc(json.tokens.USDG.address));
    expect(lc(d.defaultQuote)).toBe(lc(json.tokens.STRATEGY.address));
  });
  it("mainnet USDG untouched", () => { expect(lc(DEPLOYMENTS[4663].usdg)).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168"); });
});

describe("private launches: v6 AnonLauncher, older launchers kept for claims", () => {
  const a = ANON_ADDONS[46630];
  it("new private launches go to the v6 AnonLauncher; MarketLens is v6", () => {
    expect(lc(a.anonLauncher)).toBe(lc(json.contracts.AnonLauncher));
    expect(lc(a.marketLens)).toBe(lc(json.contracts.MarketLens));
  });
  it("v5 is the legacy launcher; v4-stack launcher still listed; current first", () => {
    expect(lc(a.anonLauncherLegacy)).toBe("0x73a2a6e049aa21a5c440f3bc358de37fe3f7c509");
    expect(anonLaunchers(46630).map(lc)).toEqual([lc(json.contracts.AnonLauncher), ...json.legacyAnonLaunchers.map(lc)]);
    expect(isLegacyLauncher(46630, a.anonLauncher)).toBe(false);
    for (const l of json.legacyAnonLaunchers) expect(isLegacyLauncher(46630, l)).toBe(true);
  });
});

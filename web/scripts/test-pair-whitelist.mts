// Launch pair whitelist (lee 2026-10-29): the list itself, the quote check, the bundler route's launch decoder for every
// launch entry point, and a pair-art logo for every listed coin.
//   pnpm test:pair-whitelist   (pure: no RPC)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { MAINNET_PAIRS, isWhitelistedQuote, pairWhitelist } from "../lib/pairWhitelist";
import { PAIR_NOT_ALLOWED_MSG, launchPairRefusal, launchQuotes } from "../lib/aa/launchQuote";
import { DEPLOYMENTS, ZERO } from "../lib/chains";
import { launchpadAbi } from "../lib/abi/Launchpad";
import { anonLauncherAbi } from "../lib/abi/AnonLauncher";
import { discipleRouterAbi } from "../lib/abi/DiscipleRouter";

const MAIN = 4663, TEST = 46630;
const AI = MAINNET_PAIRS.find((p) => p.symbol === "AI")!.address;
const MAINNET_USDG = DEPLOYMENTS[MAIN].usdg;
const WETH = "0x4200000000000000000000000000000000000006";
const account = parseAbi(["function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const batch = (...calls: { to: Address; data: Hex }[]) =>
  encodeFunctionData({ abi: account, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.to, value: BigInt(0), data: c.data }))] });
const params = (quote: string) => ({
  name: "Rocket", ticker: "RKT", imageURI: "https://x.test/i.png", description: "", socialsURI: "", quote: quote as Address,
  creatorTaxBps: 0, creatorBuyQuoteIn: BigInt(0), creatorBuyMinTokensOut: BigInt(0), deadline: BigInt(1),
});
const LP = "0x00000000000000000000000000000000000000a1" as Address;
const viaRouter = (q: string) => ({ to: LP, data: encodeFunctionData({ abi: discipleRouterAbi, functionName: "launchWithUsdg", args: [params(q), 1, BigInt(5e6), BigInt(0)] }) });
const viaLaunchpad = (q: string) => ({ to: LP, data: encodeFunctionData({ abi: launchpadAbi, functionName: "launchWithMode", args: [params(q), 1] }) });
const viaAnon = (q: string) => ({ to: LP, data: encodeFunctionData({ abi: anonLauncherAbi, functionName: "launchAnon", args: [params(q), LP, LP, "0x", "0x00", BigInt(0)] }) });
const approve = { to: LP, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [LP, BigInt(1)] }) };

test("list: 22 coins, STRATEGY first (the default), unique addresses, no USDG / WETH", () => {
  assert.equal(MAINNET_PAIRS.length, 22);
  assert.equal(MAINNET_PAIRS[0].symbol, "STRATEGY");
  assert.equal(MAINNET_PAIRS[0].address.toLowerCase(), DEPLOYMENTS[MAIN].defaultQuote.toLowerCase(), "matches the Launchpad default");
  assert.equal(new Set(MAINNET_PAIRS.map((p) => p.address.toLowerCase())).size, 22);
  for (const p of MAINNET_PAIRS) assert.match(p.address, /^0x[0-9a-fA-F]{40}$/, p.symbol);
  assert.ok(!MAINNET_PAIRS.some((p) => /^(m?USDG|W?ETH)$/i.test(p.symbol)));
});

test("quote check: listed coins and address(0) (= default STRATEGY) pass; USDG, WETH and unknown coins don't", () => {
  assert.equal(isWhitelistedQuote(ZERO, MAIN), true);
  assert.equal(isWhitelistedQuote(null, MAIN), true);
  assert.equal(isWhitelistedQuote(AI.toLowerCase(), MAIN), true, "case-insensitive");
  assert.equal(isWhitelistedQuote(MAINNET_USDG, MAIN), false);
  assert.equal(isWhitelistedQuote(WETH, MAIN), false);
  assert.equal(isWhitelistedQuote("0x00000000000000000000000000000000000000ff", MAIN), false);
});

test("testnet: only the deployment's mock STRATEGY (mainnet coins don't exist there)", () => {
  const t = pairWhitelist(TEST);
  assert.equal(t.length, 1);
  assert.equal(t[0].symbol, "STRATEGY");
  assert.equal(t[0].address.toLowerCase(), DEPLOYMENTS[TEST].defaultQuote.toLowerCase());
  assert.equal(isWhitelistedQuote(DEPLOYMENTS[TEST].defaultQuote, TEST), true);
  assert.equal(isWhitelistedQuote(DEPLOYMENTS[TEST].usdg, TEST), false, "no USDG pair on testnet either");
  assert.equal(isWhitelistedQuote(AI, TEST), false);
});

test("relay decoder: reads the quote of every launch entry point; non-launch ops pass untouched", () => {
  assert.deepEqual(launchQuotes(batch(approve, viaRouter(AI))), [AI]);
  assert.deepEqual(launchQuotes(batch(viaLaunchpad(ZERO))), [ZERO]);
  assert.deepEqual(launchQuotes(batch(viaAnon(WETH))), [WETH]);
  assert.deepEqual(launchQuotes(batch(approve)), [], "a trade / approve is not a launch");
  assert.deepEqual(launchQuotes("0x"), [], "undecodable account calldata: not a launch (other checks handle it)");
});

test("relay refusal: whitelisted pair goes, USDG / WETH / unknown are refused with the plain line", () => {
  assert.equal(launchPairRefusal(batch(approve, viaRouter(AI)), MAIN), null);
  assert.equal(launchPairRefusal(batch(viaLaunchpad(ZERO)), MAIN), null, "default pair");
  assert.equal(launchPairRefusal(batch(viaRouter(MAINNET_USDG)), MAIN), PAIR_NOT_ALLOWED_MSG);
  assert.equal(launchPairRefusal(batch(viaAnon(WETH)), MAIN), PAIR_NOT_ALLOWED_MSG, "private launches too");
  assert.equal(launchPairRefusal(batch(approve), MAIN), null, "trades are never touched");
  // a launch selector with garbage arguments is never relayed
  const bad = viaRouter(AI); bad.data = (bad.data.slice(0, 10) + "00") as Hex;
  assert.equal(launchPairRefusal(batch(bad), MAIN), PAIR_NOT_ALLOWED_MSG);
});

test("images: every listed coin has its logo, chrome coin and small coin under /public/pairs", () => {
  for (const p of MAINNET_PAIRS)
    for (const f of [`public/pairs/${p.tk}.png`, `public/pairs/coin/${p.tk}.webp`, `public/pairs/sm/${p.tk}.webp`])
      assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${p.symbol}: ${f}`);
});

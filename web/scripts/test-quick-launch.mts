/**
 * Quick Launch r4 helpers: whitelist shape, Anon/Pseudo label, socialsURI with Telegram, sign-in gate.
 * Run: npm run test:quick-launch
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "../lib/networkConfig";
import {
  DEFAULT_LAUNCH_PAIR_SYMBOL, LAUNCH_WHITELIST, addressOn, defaultLaunchPair, isUsdgSymbol, whitelistIncludesUsdg,
} from "../lib/launchWhitelist";
import {
  buildLaunchSocials, boostHasAmount, launchButtonLabel, launchNeedsSignIn, maxBoostChipLabel,
  privateLaunchHelp, privateLaunchTitle, readStoredCreatorTax, socialsURI, storeCreatorTax, withHttps,
  QUICK_LAUNCH_COPY, CREATOR_TAX_STORE_KEY,
} from "../lib/quickLaunch";
import { badgeLetters } from "../lib/decalDefault";

test("whitelist has 12 coins, STRATEGY first and default, no USDG", () => {
  assert.equal(LAUNCH_WHITELIST.length, 12);
  assert.equal(DEFAULT_LAUNCH_PAIR_SYMBOL, "STRATEGY");
  assert.equal(LAUNCH_WHITELIST[0].symbol, "STRATEGY");
  assert.equal(defaultLaunchPair().symbol, "STRATEGY");
  assert.equal(defaultLaunchPair().address, "0x168661C52E5922288dFb2b3f323b6Cf90eb21e18");
  assert.deepEqual(LAUNCH_WHITELIST.map((c) => c.symbol), [
    "STRATEGY", "AI", "SCHIFFY", "BONER", "MEME", "MOO", "PONS", "ORBIO", "HOOKR", "CASHCAT", "PRIORS", "SPACEHOOD",
  ]);
  assert.equal(whitelistIncludesUsdg(), false);
  assert.equal(LAUNCH_WHITELIST.some((c) => isUsdgSymbol(c.symbol)), false);
  for (const c of LAUNCH_WHITELIST) {
    assert.match(c.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(c.image.startsWith("/pairs/launch/"));
    assert.ok(c.name.length > 0);
    assert.equal(c.decimals, 18);
  }
});

test("STRATEGY uses the chain defaultQuote on testnet, listed address on mainnet", () => {
  const strat = defaultLaunchPair();
  const testQuote = "0xF5eB226F7f0890c36A06Cbd0Ff843292b7b1a88C" as const;
  assert.equal(addressOn(strat, MAINNET_CHAIN_ID, testQuote), strat.address);
  assert.equal(addressOn(strat, TESTNET_CHAIN_ID, testQuote), testQuote);
  const ai = LAUNCH_WHITELIST.find((c) => c.symbol === "AI")!;
  assert.equal(addressOn(ai, TESTNET_CHAIN_ID, testQuote), ai.address);
});

test("Anon launch vs Pseudo launch follows First BOOST amount", () => {
  assert.equal(privateLaunchTitle(""), "Anon launch");
  assert.equal(privateLaunchTitle("0"), "Anon launch");
  assert.equal(privateLaunchTitle("0.0"), "Anon launch");
  assert.equal(privateLaunchTitle("5"), "Pseudo launch");
  assert.equal(privateLaunchTitle("5.00"), "Pseudo launch");
  assert.equal(privateLaunchTitle("0.01"), "Pseudo launch");
  assert.equal(boostHasAmount(""), false);
  assert.equal(boostHasAmount("0"), false);
  assert.equal(boostHasAmount("5"), true);
  assert.equal(privateLaunchHelp("0"), QUICK_LAUNCH_COPY.anonHelp);
  assert.equal(privateLaunchHelp("5"), QUICK_LAUNCH_COPY.pseudoHelp);
  assert.equal(QUICK_LAUNCH_COPY.signInLine, "Sign in with email, Google, X or wallet");
});

test("launch button and Max chip labels match r4", () => {
  assert.equal(launchButtonLabel("0"), "Launch");
  assert.equal(launchButtonLabel(""), "Launch");
  assert.equal(launchButtonLabel("5"), "Launch + BOOST $5");
  assert.equal(launchButtonLabel("20"), "Launch + BOOST $20");
  assert.equal(launchButtonLabel("248.10"), "Launch + BOOST $248.10");
  assert.equal(maxBoostChipLabel(null), "Max");
  assert.equal(maxBoostChipLabel(248.1), "Max $248.10");
});

test("socialsURI includes Telegram next to twitter and website, same JSON packing", () => {
  assert.equal(socialsURI(undefined), "");
  assert.equal(buildLaunchSocials({}), undefined);
  const all = buildLaunchSocials({ twitter: "@velvetlion", telegram: "@velvetlion", website: "velvetlion.xyz" });
  assert.deepEqual(all, { twitter: "velvetlion", telegram: "velvetlion", website: "https://velvetlion.xyz" });
  assert.equal(socialsURI(all), JSON.stringify({ twitter: "velvetlion", telegram: "velvetlion", website: "https://velvetlion.xyz" }));
  const onlyTg = buildLaunchSocials({ telegram: "https://t.me/velvetlion" });
  assert.deepEqual(onlyTg, { telegram: "https://t.me/velvetlion" });
  const onlyX = buildLaunchSocials({ twitter: "maker" });
  assert.deepEqual(onlyX, { twitter: "maker" });
  assert.ok(!("telegram" in (onlyX ?? {})));
  assert.equal(withHttps("mysite.com"), "https://mysite.com");
  assert.equal(withHttps("https://mysite.com"), "https://mysite.com");
});

test("sign-in is required on a live deployment when the user is signed out, not in a static preview", () => {
  assert.equal(launchNeedsSignIn({ deployed: true, staticPreview: false, signedIn: false }), true);
  assert.equal(launchNeedsSignIn({ deployed: true, staticPreview: false, signedIn: true }), false);
  assert.equal(launchNeedsSignIn({ deployed: true, staticPreview: true, signedIn: false }), false);
  assert.equal(launchNeedsSignIn({ deployed: false, staticPreview: false, signedIn: false }), false);
});

test("generated badge letters come from the ticker; creator tax is remembered", () => {
  assert.equal(badgeLetters("LION"), "LION");
  assert.equal(badgeLetters("$lion"), "LION");
  assert.equal(badgeLetters(""), "?");
  assert.equal(badgeLetters("VERYLONGTICKER"), "VERYLONG");
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(readStoredCreatorTax(7, storage), 0);
  storeCreatorTax(1.5, storage);
  assert.equal(mem.get(CREATOR_TAX_STORE_KEY), "1.5");
  assert.equal(readStoredCreatorTax(7, storage), 1.5);
  storeCreatorTax(99, storage);
  assert.equal(readStoredCreatorTax(7, storage), 7);
});

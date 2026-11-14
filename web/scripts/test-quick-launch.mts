/**
 * Quick Launch r4 helpers: whitelist shape, Anon/Pseudo label, socialsURI with Telegram, sign-in gate.
 * Run: npm run test:quick-launch
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "../lib/networkConfig";
import {
  DEFAULT_LAUNCH_PAIR_SYMBOL, LAUNCH_WHITELIST, addressOn, defaultLaunchPair, isUsdgSymbol, launchPairsForChain, whitelistIncludesUsdg,
} from "../lib/launchWhitelist";
import { exceedsQuoteFirstBoostCap, exceedsUsdgFirstBoostCap, parseAmount } from "../lib/firstBoost";
import { WHITELIST_QUOTES, whitelistQuoteBySymbol } from "../lib/whitelistQuotes";
import {
  buildLaunchSocials, boostHasAmount, creatorTaxSteps, launchButtonLabel, launchNeedsSignIn, maxBoostChipLabel,
  isPseudoLaunch, normalizeTelegram, normalizeTwitter, normalizeWebsite, parseCreatorFeeDestination, privateLaunchHelp, privateLaunchTitle,
  readStoredCreatorFeeDestination, readStoredCreatorTax, readStoredUpload, snapCreatorTax, socialsURI, storeCreatorFeeDestination, storeCreatorTax, storeUpload, withHttps,
  QUICK_LAUNCH_COPY, QUICK_LAUNCH_MODE_CARD, QUICK_LAUNCH_MODE_COPY, CREATOR_FEE_COPY, CREATOR_FEE_DESTINATION, CREATOR_FEE_DESTINATIONS, CREATOR_FEE_DESTINATION_LIVE, PRIVATE_FEE_ROUTING_LIVE, creatorFeeRoutingAvailable, CREATOR_FEE_FIELD, CREATOR_FEE_STORE_KEY, CREATOR_TAX_HELP, CREATOR_TAX_STORE_KEY, DEFAULT_CREATOR_FEE_DESTINATION, UPLOAD_STORE_KEY, liveCreatorFeeDestination,
} from "../lib/quickLaunch";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_BOOST_COPY, FIRST_BOOST_TIP_STARTS_OPEN } from "../lib/firstBoost";
import { badgeLetters } from "../lib/decalDefault";
import { MODE } from "../lib/modeRules";

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
    assert.equal(c.image, whitelistQuoteBySymbol(c.symbol)?.imagePath);
    assert.ok(c.image.startsWith("/whitelist/"));
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
  assert.equal(LAUNCH_WHITELIST.length, WHITELIST_QUOTES.length);
  assert.deepEqual(launchPairsForChain(MAINNET_CHAIN_ID).map((c) => c.symbol), LAUNCH_WHITELIST.map((c) => c.symbol));
  assert.deepEqual(launchPairsForChain(TESTNET_CHAIN_ID).map((c) => c.symbol), ["STRATEGY"]);
});

test("First BOOST cap rejects even one microdollar over the live cap", () => {
  const dec = 18;
  const cap = parseAmount("40.18", dec)!;
  assert.equal(exceedsUsdgFirstBoostCap(cap, cap), false);
  assert.equal(exceedsUsdgFirstBoostCap(cap - BigInt(1), cap), false);
  assert.equal(exceedsUsdgFirstBoostCap(cap + BigInt(1), cap), true); // one raw unit over
  const micro = BigInt(10) ** BigInt(dec - 6); // $0.000001
  assert.equal(exceedsUsdgFirstBoostCap(cap + micro, cap), true);
  assert.equal(exceedsUsdgFirstBoostCap(null, cap), false);
  assert.equal(exceedsUsdgFirstBoostCap(cap + BigInt(1), null), false);
  const quoteCap = parseAmount("100", dec)!;
  assert.equal(exceedsQuoteFirstBoostCap(quoteCap, quoteCap), false);
  assert.equal(exceedsQuoteFirstBoostCap(quoteCap + BigInt(1), quoteCap), true);
  assert.equal(exceedsQuoteFirstBoostCap(BigInt(0), quoteCap), false);
});

test("Anon vs Pseudo follows mode and First BOOST amount", () => {
  assert.equal(QUICK_LAUNCH_COPY.anon, "Anon");
  assert.equal(QUICK_LAUNCH_COPY.pseudo, "Pseudo");
  assert.equal(privateLaunchTitle("", MODE.EASY), "Anon");
  assert.equal(privateLaunchTitle("0", MODE.EASY), "Anon");
  assert.equal(privateLaunchTitle("0.0", MODE.HARD), "Anon");
  assert.equal(privateLaunchTitle("0", MODE.TRENCH), "Anon");
  // Easy stays Anon even with a First BOOST (coins stay locked until the rocket moves to the open market).
  assert.equal(privateLaunchTitle("5", MODE.EASY), "Anon");
  assert.equal(privateLaunchTitle("5.00", MODE.EASY), "Anon");
  assert.equal(isPseudoLaunch("5", MODE.EASY), false);
  // Pseudo only on Hard or Trench when First BOOST has an amount.
  assert.equal(privateLaunchTitle("5", MODE.HARD), "Pseudo");
  assert.equal(privateLaunchTitle("5.00", MODE.HARD), "Pseudo");
  assert.equal(privateLaunchTitle("0.01", MODE.TRENCH), "Pseudo");
  assert.equal(isPseudoLaunch("5", MODE.HARD), true);
  assert.equal(isPseudoLaunch("5", MODE.TRENCH), true);
  assert.equal(boostHasAmount(""), false);
  assert.equal(boostHasAmount("0"), false);
  assert.equal(boostHasAmount("5"), true);
  assert.equal(privateLaunchHelp("0", MODE.EASY), QUICK_LAUNCH_COPY.anonHelp);
  assert.equal(privateLaunchHelp("5", MODE.EASY), QUICK_LAUNCH_COPY.anonHelp);
  assert.equal(privateLaunchHelp("5", MODE.HARD), QUICK_LAUNCH_COPY.pseudoHelp);
  assert.equal(privateLaunchHelp("5", MODE.TRENCH), QUICK_LAUNCH_COPY.pseudoHelp);
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
  assert.deepEqual(all, { twitter: "https://x.com/velvetlion", telegram: "https://t.me/velvetlion", website: "https://velvetlion.xyz" });
  assert.equal(socialsURI(all), JSON.stringify({ twitter: "https://x.com/velvetlion", telegram: "https://t.me/velvetlion", website: "https://velvetlion.xyz" }));
  const onlyTg = buildLaunchSocials({ telegram: "https://t.me/velvetlion" });
  assert.deepEqual(onlyTg, { telegram: "https://t.me/velvetlion" });
  const onlyX = buildLaunchSocials({ twitter: "maker" });
  assert.deepEqual(onlyX, { twitter: "https://x.com/maker" });
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

test("X, Telegram, and website fields turn handles into full https URLs", () => {
  assert.equal(normalizeTwitter("@0xmakerlee"), "https://x.com/0xmakerlee");
  assert.equal(normalizeTwitter("0xmakerlee"), "https://x.com/0xmakerlee");
  assert.equal(normalizeTwitter("https://x.com/0xmakerlee"), "https://x.com/0xmakerlee");
  assert.equal(normalizeTwitter("https://twitter.com/0xmakerlee"), "https://x.com/0xmakerlee");
  assert.equal(normalizeTwitter(""), undefined);
  assert.equal(normalizeTelegram("@disciple"), "https://t.me/disciple");
  assert.equal(normalizeTelegram("disciple"), "https://t.me/disciple");
  assert.equal(normalizeTelegram("https://t.me/disciple"), "https://t.me/disciple");
  assert.equal(normalizeWebsite("strategy.xyz"), "https://strategy.xyz");
  assert.equal(normalizeWebsite("https://strategy.xyz"), "https://strategy.xyz");
  assert.equal(withHttps("mysite.com"), "https://mysite.com");
});

test("First BOOST and Anon/Pseudo copy is short, and the info bubble starts closed", () => {
  assert.equal(FIRST_BOOST_TIP_STARTS_OPEN, false);
  assert.equal(FIRST_BOOST_COPY.modeCap("Easy", "1.2%"), "On Easy, your first buy can be up to 1.2% of the coins.");
  assert.equal(FIRST_BOOST_COPY.easyLock, "On Easy, that first buy stays locked until the rocket moves to the open market. Later buys you can sell anytime.");
  assert.equal(FIRST_BOOST_COPY.pveLoginUnknown, "On Easy, sign in with email, Google, or X before you launch with a first buy.");
  assert.doesNotMatch(FIRST_BOOST_COPY.easyLock, /ASCENDS/i);
  assert.equal(QUICK_LAUNCH_COPY.anonHelp, "Your name won't be shown as the creator. The account that pays can still be seen on the public record.");
  assert.equal(QUICK_LAUNCH_COPY.pseudoHelp, "Your name won't be shown as the creator. The account that pays, and the first buy, can still be seen on the public record.");
  assert.equal(QUICK_LAUNCH_COPY.uploadImage, "Upload image");
});

test("mode cards and How launching works use the short in-page copy", () => {
  assert.equal(QUICK_LAUNCH_MODE_COPY.Easy, "At first, one person can hold up to 1% of the coins. That cap rises to 3.33% as the price goes up.");
  assert.equal(QUICK_LAUNCH_MODE_COPY.Hard, "At first, one person can hold up to 3.33% of the coins. That cap rises to 7.77% as the price goes up.");
  assert.equal(QUICK_LAUNCH_MODE_COPY.Trench, "There is no cap on how many coins one person can hold.");
  assert.equal(QUICK_LAUNCH_MODE_COPY.footer, "You choose this when you launch, and you can't change it later. The caps end when the rocket moves to the open market.");
  assert.deepEqual([...QUICK_LAUNCH_COPY.howLaunchingSteps], [
    "Give your rocket a name, a ticker, and a picture.",
    "Choose how tightly one person can hold the coins, and whether to buy some at launch.",
    "When you launch, your rocket goes live and people can start trading it.",
  ]);
  assert.equal(QUICK_LAUNCH_COPY.howLaunchingSteps.length, 3);
});

test("creator tax snaps to whole numbers or halves, default 0, and is remembered", () => {
  assert.deepEqual(creatorTaxSteps(7), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7]);
  assert.equal(snapCreatorTax(0, 7), 0);
  assert.equal(snapCreatorTax(0.24, 7), 0);
  assert.equal(snapCreatorTax(0.25, 7), 0.5);
  assert.equal(snapCreatorTax(1.2, 7), 1);
  assert.equal(snapCreatorTax(1.25, 7), 1.5);
  assert.equal(snapCreatorTax(7.4, 7), 7);
  assert.equal(snapCreatorTax(-1, 7), 0);
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  storeCreatorTax(1.25, storage);
  assert.equal(readStoredCreatorTax(7, storage), 1.5);
  storeCreatorTax(0.1, storage);
  assert.equal(readStoredCreatorTax(7, storage), 0);
});

test("a chosen badge image is stored in the session so it stays after leaving the control", () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  assert.equal(readStoredUpload(storage), null);
  const uri = "data:image/png;base64,abc";
  storeUpload(uri, storage);
  assert.equal(mem.get(UPLOAD_STORE_KEY), uri);
  assert.equal(readStoredUpload(storage), uri);
  storeUpload(null, storage);
  assert.equal(readStoredUpload(storage), null);
  storeUpload("https://example.com/x.png", storage);
  assert.equal(readStoredUpload(storage), null);
});

test("creator fee destination is a three-way exclusive choice, default is the creator keeps the fees", () => {
  assert.equal(CREATOR_FEE_FIELD, "creatorFeeDestination");
  assert.deepEqual([...CREATOR_FEE_DESTINATIONS], [0, 1, 2]);
  assert.equal(DEFAULT_CREATOR_FEE_DESTINATION, 0);
  assert.equal(CREATOR_FEE_DESTINATION.creator, 0);
  assert.equal(CREATOR_FEE_DESTINATION.lockedPool, 1);
  assert.equal(CREATOR_FEE_DESTINATION.buyAndBurnQuote, 2);
  assert.equal(parseCreatorFeeDestination(undefined), 0);
  assert.equal(parseCreatorFeeDestination(""), 0);
  assert.equal(parseCreatorFeeDestination("nope"), 0);
  assert.equal(parseCreatorFeeDestination("1"), 1);
  assert.equal(parseCreatorFeeDestination(2), 2);
  assert.equal(parseCreatorFeeDestination("0"), 0);
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(readStoredCreatorFeeDestination(storage), 0);
  storeCreatorFeeDestination(1, storage);
  assert.equal(mem.get(CREATOR_FEE_STORE_KEY), "1");
  assert.equal(readStoredCreatorFeeDestination(storage), 1);
  storeCreatorFeeDestination(2, storage);
  assert.equal(readStoredCreatorFeeDestination(storage), 2);
  storeCreatorFeeDestination(0, storage);
  assert.equal(readStoredCreatorFeeDestination(storage), 0);
});

test("creator fee copy matches the r7 card labels and tax helpers, with no jargon", () => {
  assert.equal(QUICK_LAUNCH_COPY.creatorFees, "Creator fees");
  assert.equal(QUICK_LAUNCH_COPY.creatorFeesPerm, "You pick this when you launch, and you can't change it later.");
  assert.equal(QUICK_LAUNCH_COPY.rewards, "Send your creator fees to a different account");
  assert.equal(QUICK_LAUNCH_COPY.rewardsHelp, "Your creator fees go to this account instead of you. You'll confirm this one extra time.");
  const H = "0x4e94a3e9900b435b7c91d0a7cd53a22c8a9f8a03";
  assert.equal(CREATOR_FEE_DESTINATION_LIVE, true);
  assert.equal(liveCreatorFeeDestination(0, { harvest: H }), undefined, "keep never goes through the harvest");
  assert.equal(liveCreatorFeeDestination(1, { harvest: H }), 1);
  assert.equal(liveCreatorFeeDestination(2, { harvest: H }), 2);
  assert.equal(liveCreatorFeeDestination(1), undefined, "no harvest on this chain");
  assert.equal(liveCreatorFeeDestination(2, { harvest: "0x0000000000000000000000000000000000000000" }), undefined);
  assert.equal(CREATOR_FEE_COPY[0].sentence, "You keep the creator fees.");
  assert.equal(CREATOR_FEE_COPY[0].chip, "");
  assert.equal(CREATOR_FEE_COPY[1].sentence, "Fees go into the locked pool.");
  assert.equal(CREATOR_FEE_COPY[1].chip, "Fees stay in the pool");
  assert.equal(CREATOR_FEE_COPY[2].sentence, "Fees buy and burn the pair coin.");
  assert.equal(CREATOR_FEE_COPY[2].chip, "Fees buy and burn the pair coin");
  assert.equal(CREATOR_TAX_HELP[0], "You already get 33% of every trading fee. Creator tax is an extra cut on top of that. Higher tax can scare off players.");
  assert.equal(CREATOR_TAX_HELP[1], "The 33% of every trading fee goes into the locked pool. Creator tax is an extra cut on top of that, and it goes there too. Higher tax can scare off players.");
  assert.equal(CREATOR_TAX_HELP[2], "The 33% of every trading fee is used to buy and burn the pair coin. Creator tax is an extra cut on top of that, and it is used the same way. Higher tax can scare off players.");
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, "../app/create/page.tsx"), "utf8");
  const css = readFileSync(join(here, "../components/create/quickLaunch.module.css"), "utf8");
  assert.equal(QUICK_LAUNCH_COPY.creatorFeeSplit, "You earn 33% of every trading fee, forever.");
  const visible = [
    QUICK_LAUNCH_COPY.creatorFees, QUICK_LAUNCH_COPY.creatorFeesPerm, QUICK_LAUNCH_COPY.creatorFeeSplit,
    QUICK_LAUNCH_COPY.rewards, QUICK_LAUNCH_COPY.rewardsHelp,
    ...CREATOR_FEE_DESTINATIONS.flatMap((id) => [CREATOR_FEE_COPY[id].sentence, CREATOR_FEE_COPY[id].chip, CREATOR_TAX_HELP[id]]),
  ].join("\n");
  assert.doesNotMatch(visible, /\bLP\b|quote token|renounced|\buint\b|\bhalf\b|creator rewards|available once the new contracts are live/i);
  assert.doesNotMatch(page, /available once the new contracts are live|creator rewards|creatorFeesPending/i);
  assert.match(page, /creatorFeeDestination: sendFeeDest/, "the launch sends the chosen destination");
  const feeCss = css.slice(css.indexOf(".feeCards"), css.indexOf(".feePerm") + 80);
  assert.match(feeCss, /grid-template-columns:\s*repeat\(3,/);
  assert.doesNotMatch(feeCss, /#F2C14E|#FF7A3D|gold|orange/i);
  assert.match(page, /data-testid=\{\`fee-destination-\$\{id\}\`\}/);
  assert.match(page, /CREATOR_TAX_HELP\[feeDestination\]/);
  assert.match(page, /liveCreatorFeeDestination\(feeDestination, \{ private: privateLaunch/);
});


test("the creator fee split is on the closed Quick Launch page and in Advanced, and does not change with the destination", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, "../app/create/page.tsx"), "utf8");
  assert.match(page, /data-testid="creator-fee-split"/);
  assert.match(page, /data-testid="creator-fee-split-advanced"/);
  assert.equal((page.match(/C\.creatorFeeSplit/g) || []).length, 2);
  assert.equal(QUICK_LAUNCH_COPY.creatorFeeSplit, "You earn 33% of every trading fee, forever.");
  assert.doesNotMatch(page, /Every trade pays a 1% fee/);
  assert.doesNotMatch(QUICK_LAUNCH_COPY.creatorFeeSplit, /Every trade pays a 1% fee|0\.33%|\.33%|33% creator/);
  // Same constant in both places; not rewritten for pool or burn.
  assert.doesNotMatch(page, /creatorFeeSplit\[feeDestination\]|CREATOR_FEE_COPY\[feeDestination\]\.split/);
  // Not on the illustrated cards (cards still use the short destination labels).
  const cardBlock = page.slice(page.indexOf("feeCards"), page.indexOf("creatorFeesPerm"));
  assert.match(cardBlock, /CREATOR_FEE_COPY\[id\]\.sentence/);
  assert.doesNotMatch(cardBlock, /creatorFeeSplit/);
  assert.equal(QUICK_LAUNCH_COPY.creatorFeesPerm, "You pick this when you launch, and you can't change it later.");
  assert.equal(CREATOR_TAX_HELP[0], "You already get 33% of every trading fee. Creator tax is an extra cut on top of that. Higher tax can scare off players.");
  assert.equal(CREATOR_TAX_HELP[1], "The 33% of every trading fee goes into the locked pool. Creator tax is an extra cut on top of that, and it goes there too. Higher tax can scare off players.");
  assert.equal(CREATOR_TAX_HELP[2], "The 33% of every trading fee is used to buy and burn the pair coin. Creator tax is an extra cut on top of that, and it is used the same way. Higher tax can scare off players.");
  assert.equal(CREATOR_FEE_DESTINATION_LIVE, true);
});

test("private launches can't pick pool or burn until the harvest with refundTo is live", () => {
  const H = "0x4e94a3e9900b435b7c91d0a7cd53a22c8a9f8a03";
  assert.equal(PRIVATE_FEE_ROUTING_LIVE, false);
  assert.equal(creatorFeeRoutingAvailable({ harvest: H }), true);
  assert.equal(creatorFeeRoutingAvailable({ private: true, harvest: H }), false);
  assert.equal(liveCreatorFeeDestination(1, { private: true, harvest: H }), undefined);
  const here = dirname(fileURLToPath(import.meta.url));
  const page = readFileSync(join(here, "../app/create/page.tsx"), "utf8");
  assert.match(page, /disabled=\{off\}/, "pool and burn cards are disabled where they can't be sent");
  assert.match(page, /data-testid="fee-destination-later"/);
  assert.equal(QUICK_LAUNCH_COPY.creatorFeesPrivateLater, "Private launches keep the creator fees for now.");
});
test("Difficulty is three cards with the caps written on them (canvas board \"Launch: build your rocket\")", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, "../components/create/launch.module.css"), "utf8");
  const page = readFileSync(join(here, "../app/create/page.tsx"), "utf8");
  assert.match(css, /\.diffs\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
  assert.match(page, /data-testid=\{`mode-card-\$\{label\.toLowerCase\(\)\}`\}/);
  assert.match(page, /QUICK_LAUNCH_MODE_CARD\.footer/);
  assert.match(page, /data-testid="mode-cards"/);
  assert.match(QUICK_LAUNCH_MODE_CARD.Easy.blurb, /1%/);
  assert.match(QUICK_LAUNCH_MODE_CARD.Hard.blurb, /3\.33%/);
  assert.match(QUICK_LAUNCH_MODE_CARD.Trench.blurb, /No caps/);
  assert.equal(QUICK_LAUNCH_MODE_CARD.Trench.label, "Expert");
  assert.doesNotMatch(page, /modesFoot|mode-modal|modeBtn|modeOpen/);
});

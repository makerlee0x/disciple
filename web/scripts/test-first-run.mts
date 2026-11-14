// Phone first run (maker, 2026-11-14): first-run record, Add to Home Screen backoff, in-app browser detection,
// card checkout error lines, and the $3 boost minimum.   pnpm test:first-run
import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_RUN, INSTALL_BACKOFF_MS, sanitizeRun, shouldOfferInstall, showFlightIntro, showPickCoach } from "../lib/firstRun.ts";
import { chromeIntent, inAppKind, isIOS } from "../lib/inAppBrowser.ts";
import { FUND_COPY, fundErrorLine } from "../lib/fund.ts";
import { MIN_BOOST_USD, validBoost } from "../lib/trade/swapSettings.ts";

const PHONE = { phone: true, standalone: false, inApp: false, now: 1_000_000_000_000 };
const DAY = 86_400_000;

test("sanitizeRun keeps only good values", () => {
  assert.deepEqual(sanitizeRun(null), EMPTY_RUN);
  assert.deepEqual(sanitizeRun("x"), EMPTY_RUN);
  assert.deepEqual(sanitizeRun({ flown: "yes", intro: true, boosts: -3, installAt: "12.7", installNo: NaN }), { flown: false, intro: true, boosts: 0, installAt: 12, installNo: 0 });
});

test("coach and intro show until done", () => {
  assert.equal(showPickCoach(EMPTY_RUN, true), true);
  assert.equal(showPickCoach(EMPTY_RUN, false), false);
  assert.equal(showPickCoach({ ...EMPTY_RUN, flown: true }, true), false);
  assert.equal(showFlightIntro(EMPTY_RUN), true);
  assert.equal(showFlightIntro({ ...EMPTY_RUN, intro: true }), false);
});

test("install prompt: only after a boost, on a phone browser", () => {
  const r = { ...EMPTY_RUN, boosts: 1 };
  assert.equal(shouldOfferInstall(EMPTY_RUN, PHONE), false);
  assert.equal(shouldOfferInstall(r, PHONE), true);
  assert.equal(shouldOfferInstall(r, { ...PHONE, phone: false }), false);
  assert.equal(shouldOfferInstall(r, { ...PHONE, standalone: true }), false);
  assert.equal(shouldOfferInstall(r, { ...PHONE, inApp: true }), false);
});

test("install prompt backs off: 3 days, 14 days, then never", () => {
  const at = PHONE.now;
  const shown = { ...EMPTY_RUN, boosts: 2, installAt: at };
  assert.equal(shouldOfferInstall(shown, { ...PHONE, now: at + DAY }), false);
  assert.equal(shouldOfferInstall(shown, { ...PHONE, now: at + INSTALL_BACKOFF_MS[0] }), true);
  const no1 = { ...shown, installNo: 1 };
  assert.equal(shouldOfferInstall(no1, { ...PHONE, now: at + 2 * DAY }), false);
  assert.equal(shouldOfferInstall(no1, { ...PHONE, now: at + 3 * DAY }), true);
  const no2 = { ...shown, installNo: 2 };
  assert.equal(shouldOfferInstall(no2, { ...PHONE, now: at + 13 * DAY }), false);
  assert.equal(shouldOfferInstall(no2, { ...PHONE, now: at + 14 * DAY }), true);
  assert.equal(shouldOfferInstall({ ...shown, installNo: 3 }, { ...PHONE, now: at + 365 * DAY }), false);
  assert.equal(shouldOfferInstall({ ...shown, installNo: 9 }, { ...PHONE, now: at + 365 * DAY }), false);
});

test("in-app browsers are named; real browsers are not", () => {
  const ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  assert.equal(inAppKind(`${ios} Twitter for iPhone/10.62`), "x");
  assert.equal(inAppKind("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 TwitterAndroid"), "x");
  assert.equal(inAppKind(`${ios} Telegram`), "telegram");
  assert.equal(inAppKind(`${ios} Instagram 350.0`), "instagram");
  assert.equal(inAppKind(`${ios} [FBAN/FBIOS;FBAV/480.0]`), "facebook");
  assert.equal(inAppKind(`${ios} musical_ly_37.0`), "tiktok");
  assert.equal(inAppKind("Mozilla/5.0 (Linux; Android 14; SM-S921B; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36"), "other");
  assert.equal(inAppKind(`${ios} Version/18.1 Safari/604.1`), null);
  assert.equal(inAppKind("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36"), null);
  assert.equal(isIOS(ios), true);
});

test("Android intent link opens the same page in Chrome", () => {
  assert.equal(chromeIntent("https://disciple.vip/flight/abc?ref=x#top"), "intent://disciple.vip/flight/abc?ref=x#top#Intent;scheme=https;package=com.android.chrome;end");
  assert.equal(chromeIntent("not a url"), null);
});

test("card checkout errors become one plain line", () => {
  assert.equal(fundErrorLine(new Error("User exited the funding flow")), FUND_COPY.closed);
  assert.equal(fundErrorLine("Modal closed"), FUND_COPY.closed);
  assert.equal(fundErrorLine({ message: "User rejected request" }), FUND_COPY.closed);
  assert.equal(fundErrorLine(new Error("Funding is not enabled for this app")), FUND_COPY.unavailable);
  assert.equal(fundErrorLine(null), FUND_COPY.unavailable);
});

test("each boost preset is at least $3 (covers the network fee)", () => {
  assert.equal(MIN_BOOST_USD, 3);
  assert.equal(validBoost(3), true);
  assert.equal(validBoost(2.99), false);
  assert.equal(validBoost(NaN), false);
  assert.equal(validBoost(Infinity), false);
});

test("throttle notches: up = boost presets, down = dump sizes, ALL last", async () => {
  const { notchAt, sellFracs, THR_UP } = await import("../components/flight/PhoneThrottle.tsx");
  const up = 150, down = 150;
  assert.equal(notchAt(0, up, down, 4, 4), null);
  assert.equal(notchAt(-10, up, down, 4, 4), null);
  assert.deepEqual(notchAt(-THR_UP[0] * up, up, down, 4, 4), { side: "buy", i: 0 });
  assert.deepEqual(notchAt(-THR_UP[3] * up, up, down, 4, 4), { side: "buy", i: 3 });
  assert.deepEqual(notchAt(-999, up, down, 4, 4), { side: "buy", i: 3 });
  assert.deepEqual(notchAt(-THR_UP[3] * up, up, down, 2, 4), { side: "buy", i: 1 });   // fewer presets: no phantom notch
  const f = sellFracs(4);
  assert.deepEqual(f, [0.3, 0.513, 0.727, 0.94]);
  assert.deepEqual(notchAt(f[0] * down, up, down, 4, 4), { side: "sell", i: 0 });
  assert.deepEqual(notchAt(999, up, down, 4, 4), { side: "sell", i: 3 });
  assert.deepEqual(sellFracs(1), [0.94]);
  assert.deepEqual(sellFracs(0), []);
});

// DISCIPLE iPhone app (Capacitor wrap, native plan 2026-11-14): deep links, universal-link file, APNs signing/payload,
// push devices (browser + app on one wallet), delete account, haptics map, in-app-browser rule.
//   pnpm test:native   (local KV file in /tmp, fetch injected, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, verify } from "node:crypto";

delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
process.env.KV_LOCAL_FILE = join(tmpdir(), `native-test-${process.pid}.json`);
const N = await import("../lib/native");
const { aasa } = await import("../lib/nativeLinks");
const A = await import("../lib/server/apns");
const P = await import("../lib/server/push");
const { deleteAccount } = await import("../lib/server/deleteAccount");
const { kv } = await import("../lib/server/kv");
const { inAppKind } = await import("../lib/inAppBrowser");
import { readFileSync } from "node:fs";

const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DiscipleApp/1";

test("app detection by user agent; our app is never an 'in-app browser'", () => {
  assert.equal(N.isNativeAppUa(APP_UA), true);
  assert.equal(N.isNativeAppUa("Mozilla/5.0 (iPhone) Safari/604.1"), false);
  assert.equal(inAppKind(APP_UA), null);
  assert.equal(inAppKind("Mozilla/5.0 (iPhone) Twitter for iPhone"), "x");
  assert.equal(N.isNativeApp(), false);   // node: no window, no Capacitor
  assert.equal(N.nativeHaptic("boost"), false);
});

test("every haptic kind has a Taptic Engine buzz", () => {
  // lib/game/haptics imports React (settings hook), so read its kinds from the source instead of importing it
  const src = readFileSync(new URL("../lib/game/haptics.ts", import.meta.url), "utf8");
  const kinds = [...src.match(/export type HapticKind = ([^;]+);/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 10);
  for (const k of kinds) assert.ok(N.NATIVE_HAPTICS[k], `native haptic for ${k}`);
});

test("deep links: universal links and disciple:// open inside the site; other hosts don't", () => {
  assert.equal(N.deepLinkPath("https://disciple.vip/coin/0xabc?ref=x#chat"), "/coin/0xabc?ref=x#chat");
  assert.equal(N.deepLinkPath("https://www.disciple.vip/"), "/");
  assert.equal(N.deepLinkPath("disciple://turbo/duel?c=DUEL-ABCD"), "/turbo/duel?c=DUEL-ABCD");
  assert.equal(N.deepLinkPath("https://evil.example/coin/0xabc"), null);
  assert.equal(N.deepLinkPath("http://disciple.vip/coin"), null);
  assert.equal(N.deepLinkPath("not a url"), null);
  // never a protocol-relative path that would leave the site
  assert.equal(N.deepLinkPath("https://disciple.vip//evil.example/x"), "/evil.example/x");
  assert.equal(N.deepLinkPath("disciple:////evil.example"), "/evil.example");
  assert.equal(N.safeInSitePath("//evil.example"), "/evil.example");
  assert.equal(N.safeInSitePath("/\\evil.example"), "/evil.example");
  assert.equal(N.safeInSitePath("https://evil.example"), null);
  assert.equal(N.safeInSitePath(42), null);
});

test("apple-app-site-association: lists the app only with a team id, never the API", () => {
  assert.deepEqual(aasa({}).applinks.details, []);
  assert.deepEqual(aasa({ APPLE_TEAM_ID: "bad" }).applinks.details, []);
  const f = aasa({ APPLE_TEAM_ID: "ABCDE12345" });
  assert.deepEqual(f.applinks.details[0].appIDs, ["ABCDE12345.vip.disciple.app"]);
  assert.deepEqual(f.applinks.details[0].components[0], { "/": "/api/*", exclude: true });
  assert.equal(aasa({ APPLE_TEAM_ID: "ABCDE12345", APNS_BUNDLE_ID: "com.x.y" }).webcredentials.apps[0], "ABCDE12345.com.x.y");
});

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = { APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_KEY_P8: P8.replace(/\n/g, "\\n") } as NodeJS.ProcessEnv;

test("APNs: keys from env, ES256 provider token Apple can verify, alert payload with the tap path", () => {
  assert.equal(A.apnsKeys({} as NodeJS.ProcessEnv), null);
  assert.equal(A.apnsKeys({ ...ENV, APNS_KEY_ID: "short" }), null);
  const k = A.apnsKeys(ENV)!;
  assert.equal(k.bundleId, "vip.disciple.app");
  const jwt = A.apnsJwt(k, 1_800_000_000_000);
  const [h, b, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url").toString()), { iss: "TEAM123456", iat: 1_800_000_000 });
  assert.ok(verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.equal(A.apnsJwt(k, 1_800_000_000_000 + 60_000), jwt, "cached for 40 minutes");
  const pl = JSON.parse(A.apnsPayload({ title: "Orbit", body: "$DOGE hit orbit", url: "/coin/0x1" }));
  assert.deepEqual(pl.aps.alert, { title: "Orbit", body: "$DOGE hit orbit" });
  assert.equal(pl.url, "/coin/0x1");
  assert.equal(A.validApnsToken("ab".repeat(32)), true);
  assert.equal(A.validApnsToken("zz".repeat(32)), false);
});

const W = "0x" + "c".repeat(40);
const TOKEN = "ab".repeat(32);
const EP = "https://fcm.googleapis.com/fcm/send/xyz";

test("push devices: a browser and the app share one wallet; removing one keeps the other", async () => {
  assert.deepEqual(P.readDevice({ apns: TOKEN, env: "sandbox" }), { apns: TOKEN, env: "sandbox" });
  assert.deepEqual(P.readDevice({ apns: TOKEN }), { apns: TOKEN, env: "production" });
  assert.equal(P.readDevice({ apns: "nope" }), null);
  assert.equal(await P.subscribe(W, EP), true);
  assert.equal(await P.subscribe(W, { apns: TOKEN, env: "production" }), true);
  assert.equal(await P.subscribe(W, { apns: TOKEN, env: "production" }), true);   // same phone again: no duplicate
  assert.equal((await P.subsOf(W)).length, 2);
  await P.unsubscribe(W, { apns: TOKEN });
  assert.deepEqual(await P.subsOf(W), [{ endpoint: EP }]);
  const epKey = `push:ep:${(await import("node:crypto")).createHash("sha256").update(EP).digest("hex")}`;
  assert.equal(await kv().get(epKey), W);
  // cleanup after a 410 passes the stored device object: the endpoint→wallet capability must go too
  assert.deepEqual(P.readDevice({ endpoint: EP }), { endpoint: EP });
  await P.unsubscribe(W, { endpoint: EP });
  assert.deepEqual(await P.subsOf(W), []);
  assert.equal(await kv().get(epKey), null);
  assert.equal(await P.latestFor(EP), null);
});

test("delete account: wipes name, profile and alerts for every wallet, then deletes the Privy user", async () => {
  const s = kv();
  await s.set(`user:addr:${W}`, "pilot"); await s.set("user:name:pilot", W); await s.set(`user:meta:${W}`, "{}");
  await P.subscribe(W, { apns: TOKEN, env: "production" });
  const calls: { url: string; method?: string; auth?: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.authorization }); return new Response(null, { status: 200 }); }) as typeof fetch;
  const pe = { appId: "appid12345", appSecret: "secret" };
  const r = await deleteAccount({ id: "did:privy:abc12345", wallets: [W] }, pe, s, f);
  assert.deepEqual(r, { ok: true, wallets: 1, privyDeleted: true });
  for (const k of [`user:addr:${W}`, "user:name:pilot", `user:meta:${W}`, `push:subs:${W}`]) assert.equal(await s.get(k), null, k);
  assert.equal(calls[0].url, "https://api.privy.io/v1/users/did:privy:abc12345");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("appid12345:secret").toString("base64")}`);
  const fail = (async () => new Response(null, { status: 500 })) as typeof fetch;
  const r2 = await deleteAccount({ id: "did:privy:abc12345", wallets: [W] }, pe, s, fail);
  assert.equal(r2.ok, false);
});

// ---------------------------------------------------------------- phone flight feel (2026-11-14 "do them all")
const F = await import("../lib/flight/feel");
const X = await import("../lib/xp");
const ME = await import("../lib/missionsEval");

test("full-screen flying rests only on a phone, after the wait, with no sheet or dialog open", () => {
  const base = { on: true, phone: true, sheetOpen: false, dialog: false, sinceWake: F.CALM_MS };
  assert.equal(F.calmNow(base), true);
  assert.equal(F.calmNow({ ...base, sinceWake: F.CALM_MS - 1 }), false);
  assert.equal(F.calmNow({ ...base, on: false }), false);
  assert.equal(F.calmNow({ ...base, phone: false }), false);
  assert.equal(F.calmNow({ ...base, sheetOpen: true }), false);
  assert.equal(F.calmNow({ ...base, dialog: true }), false);
});

test("tilt: dead zone, linear to the edge, clamped, signed", () => {
  assert.equal(F.tiltToX(0), 0);
  assert.equal(F.tiltToX(F.TILT_DEAD_DEG), 0);
  assert.equal(F.tiltToX(F.TILT_FULL_DEG), 1);
  assert.equal(F.tiltToX(-90), -1);
  assert.ok(Math.abs(F.tiltToX((F.TILT_DEAD_DEG + F.TILT_FULL_DEG) / 2) - 0.5) < 1e-9);
  assert.equal(F.tiltToX(Number.NaN), 0);
});

test("style XP: small, capped multiplier", () => {
  assert.equal(X.styleXp(1), X.STYLE.base);
  assert.equal(X.styleXp(2), X.STYLE.base * 2);
  assert.equal(X.styleXp(9), X.STYLE.base * X.STYLE.maxMult);
  assert.equal(X.styleXp(Number.NaN), X.STYLE.base);
});

test("style fills pay only when the wallet's own $5+ buy on that coin backs them", () => {
  const day = X.dayPeriod(Date.UTC(2026, 10, 14, 12));
  const coin = "0x" + "a".repeat(40), other = "0x" + "b".repeat(40), t0 = day.start + 3_600_000;
  const fill = (c: string, ts: number, usd: number, side: "buy" | "sell" = "buy") => ({ coin: c, ts, block: 1, logIndex: ts % 1000, side, tokens: 1, usd });
  const fills = [fill(coin, t0 + 2_000, 10), fill(coin, t0 + 60_000, 3), fill(other, t0 + 120_000, 20), fill(coin, t0 + 180_000, 20, "sell")];
  const claims = [
    { coin, at: t0, mult: 2 },              // backed (buy 2 s later)
    { coin, at: t0 + 5_000, mult: 1 },      // too soon after the last one
    { coin, at: t0 + 60_000, mult: 1 },     // buy under $5
    { coin, at: t0 + 120_000, mult: 3 },    // the buy was on another coin
    { coin, at: t0 + 180_000, mult: 1 },    // a sell, not a buy
  ];
  const ok = ME.evaluateStyle({ wallet: "0x" + "c".repeat(40), fills, claims, asOf: t0 + 999_999 }, day);
  assert.deepEqual(ok.map((c) => c.at), [t0]);
  // one buy backs one claim, and the day stops at the cap
  const many = Array.from({ length: X.STYLE.perDay + 3 }, (_, i) => ({ coin, at: t0 + i * 20_000, mult: 1 }));
  const mf = many.map((c) => fill(coin, c.at + 1_000, 10));
  assert.equal(ME.evaluateStyle({ wallet: "0x" + "c".repeat(40), fills: mf, claims: many, asOf: t0 + 9e6 }, day).length, X.STYLE.perDay);
});

test("Live Activity: state from the HUD and from a server position, APNs payload shape", async () => {
  const L = await import("../lib/liveFlight");
  const { TOTAL_SUPPLY_TOKENS } = await import("../lib/trades");
  const s = L.liveStateOf({ mcap: 94_230, bagUsd: 12.345, pnlUsd: -1.239, pnlPct: -9.87, closed: false });
  assert.deepEqual(Object.keys(s).sort(), ["bagUsd", "closed", "mcap", "pnlPct", "pnlUsd", "zone"]);   // = FlightActivityAttributes.ContentState
  assert.equal(s.mcap, "$94.2K"); assert.equal(s.bagUsd, 12.35); assert.equal(s.pnlUsd, -1.24); assert.equal(s.pnlPct, -9.9); assert.ok(s.zone.length > 0);
  const p = L.liveState({ kind: "unrealized", holding: TOTAL_SUPPLY_TOKENS / 1000, mcapEndUsd: 50_000, gainUsd: 10, gainPct: 25 });
  assert.equal(p.bagUsd, 50); assert.equal(p.closed, false);
  assert.equal(L.liveState({ kind: "realized", holding: 0, mcapEndUsd: 50_000, gainUsd: 3, gainPct: 5 }).closed, true);
  const j = JSON.parse(A.liveActivityPayload(s, "end", 1_700_000_000_000));
  assert.equal(j.aps.event, "end"); assert.equal(j.aps.timestamp, 1_700_000_000); assert.deepEqual(j.aps["content-state"], s);
  assert.ok(j.aps["dismissal-date"] > j.aps.timestamp);
  assert.equal(JSON.parse(A.liveActivityPayload(s, "update", 1_700_000_000_000)).aps["dismissal-date"], undefined);
});

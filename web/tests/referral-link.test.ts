/**
 * Referral link path (funnel-and-referral-attribution plan, "Link check"). Checks the EXISTING first-touch code only
 * (lib/referral.ts + app/r/[username]/route.ts); nothing here changes login or trade. Same rules as Rewardful/Impact-
 * style affiliate tracking: first touch wins for 30 days, a later link does not overwrite it, no self-referral.
 * On-chain parts (tryAttribute, the $10 lock, FeeRouter payee) are checked live against testnet, not here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/usernames", () => ({
  usernameOf: vi.fn(async (a: string) => (a === ALICE ? "alice" : null)),
  walletOf: vi.fn(async (u: string) => (u === "alice" ? ALICE : u === "carol" ? CAROL : null)),
}));

const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";
const CAROL = "0x00000000000000000000000000000000000ca201";
const DAY = 24 * 3600 * 1000;

import { REF_COOKIE, REF_LS, REF_TTL_MS, captureRefFromCookie, captureRefFromQuery, currentRef, parseRef, referrerWallet } from "@/lib/referral";
import { GET as refLanding } from "@/app/r/[username]/route";

// minimal browser globals (vitest env is node)
let store: Record<string, string> = {};
let cookie = "";
beforeEach(() => {
  store = {};
  cookie = "";
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("document", { get cookie() { return cookie; } });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Opens /r/<slug> with an optional existing cookie; returns the Set-Cookie value (or null) the server sent. */
async function openRefLink(slug: string, existingCookie?: string): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (existingCookie) headers.cookie = `${REF_COOKIE}=${encodeURIComponent(existingCookie)}`;
  const res = await refLanding(new NextRequest(`https://disciple.vip/r/${slug}`, { headers }), { params: Promise.resolve({ username: slug }) });
  expect(res.status).toBe(307);
  return res.cookies.get(REF_COOKIE)?.value ?? null;
}
const browserGets = (v: string) => { cookie = `${REF_COOKIE}=${encodeURIComponent(v)}`; };

describe("link check (first touch, 30 days)", () => {
  it("opening Alice's /r/ link stores Alice in the cookie and in local storage", async () => {
    const set = await openRefLink("alice");
    expect(set).toBeTruthy();
    expect(parseRef(set!)?.a).toBe(ALICE);
    browserGets(set!);
    captureRefFromCookie(); // RefCapture in AppShell
    expect(parseRef(store[REF_LS])?.a).toBe(ALICE);
    expect(referrerWallet(BOB)).toBe(ALICE);
  });

  it("a /r/<wallet> link works the same", async () => {
    const set = await openRefLink(ALICE);
    expect(parseRef(set!)).toMatchObject({ a: ALICE, u: "alice" });
  });

  it("a coin share link with ?ref=Alice stores Alice when no earlier link is stored", () => {
    captureRefFromQuery(`?ref=${ALICE}`);
    expect(parseRef(store[REF_LS])?.a).toBe(ALICE);
  });

  it("a second person's link after that does not replace Alice (server cookie and local storage)", async () => {
    const first = (await openRefLink("alice"))!;
    expect(await openRefLink("carol", first)).toBeNull(); // server: cookie already present → not rewritten
    browserGets(first);
    captureRefFromCookie();
    captureRefFromQuery(`?ref=${CAROL}`);
    browserGets(JSON.stringify({ u: "carol", a: CAROL, t: Date.now() })); // even if the cookie somehow changed
    captureRefFromCookie();
    expect(parseRef(store[REF_LS])?.a).toBe(ALICE);
    expect(currentRef()?.a).toBe(ALICE);
  });

  it("after Bob signs in, the stored referrer is still Alice (nothing on sign-in rewrites it)", () => {
    captureRefFromQuery(`?ref=${ALICE}`);
    // sign-in only gives us Bob's address; the trade path asks referrerWallet(me)
    expect(referrerWallet(BOB)).toBe(ALICE);
    expect(parseRef(store[REF_LS])?.a).toBe(ALICE);
  });

  it("Bob is never sent as his own referrer", () => {
    captureRefFromQuery(`?ref=${BOB}`);
    expect(referrerWallet(BOB)).toBeNull();
    expect(referrerWallet(BOB.toUpperCase().replace("0X", "0x"))).toBeNull();
  });

  it("an expired 30-day touch does not attach, and a fresh link can then replace it", () => {
    const old = JSON.stringify({ u: null, a: ALICE, t: Date.now() - REF_TTL_MS - DAY });
    expect(parseRef(old)).toBeNull();
    store[REF_LS] = old;
    browserGets(old);
    expect(currentRef()).toBeNull();
    expect(referrerWallet(BOB)).toBeNull();
    captureRefFromQuery(`?ref=${CAROL}`);
    expect(referrerWallet(BOB)).toBe(CAROL);
    // just inside 30 days still counts
    expect(parseRef(JSON.stringify({ u: null, a: ALICE, t: Date.now() - REF_TTL_MS + DAY }))?.a).toBe(ALICE);
  });

  it("server ignores an expired cookie (a new first touch is written)", async () => {
    const old = JSON.stringify({ u: "alice", a: ALICE, t: Date.now() - REF_TTL_MS - DAY });
    expect(parseRef((await openRefLink("carol", old))!)?.a).toBe(CAROL);
  });

  it("no link opened ⇒ no referrer (trade path sends nothing)", () => {
    expect(currentRef()).toBeNull();
    expect(referrerWallet(BOB)).toBeNull();
  });
});

/**
 * Public coin links (maker 2026-11-20): disciple.vip/rocket/robinhood/<CA>?r=<username | wallet>.
 * lib/coinPath (path parse + build), coinRefLink (share link), ?r= first touch (wallet now, username via the resolve API).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coinFromPath, isCoinPath, rocketPath } from "@/lib/coinPath";
import { REF_LS, captureRefFromQuery, captureRefUsernameFromQuery, coinRefLink, currentRef } from "@/lib/referral";

const COIN = "0x070749Ac5e8De13bFc48D9cf8D2aa38312DEF819";
const ALICE = "0x00000000000000000000000000000000000a11ce";

let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("document", { cookie: "" });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("coin paths", () => {
  it("builds the rocket path, lowercase", () => expect(rocketPath(COIN)).toBe(`/rocket/robinhood/${COIN.toLowerCase()}`));
  it("reads the coin from both paths (and a base path)", () => {
    expect(coinFromPath(`/rocket/robinhood/${COIN}`)).toBe(COIN.toLowerCase());
    expect(coinFromPath(`/coin/${COIN}`)).toBe(COIN.toLowerCase());
    expect(coinFromPath(`/makerlee0x/disciple/preview/coin/${COIN}/`)).toBe(COIN.toLowerCase());
    expect(isCoinPath("/rocket")).toBe(false);
    expect(isCoinPath("/rocket/robinhood/0x123")).toBe(false);
    expect(isCoinPath(`/coin/${COIN}x`)).toBe(false);
  });
});

describe("share link", () => {
  it("username wins, wallet stands in, nothing ⇒ bare link", () => {
    expect(coinRefLink(COIN, "MakerLee", ALICE, "https://www.disciple.vip")).toBe(`https://www.disciple.vip/rocket/robinhood/${COIN.toLowerCase()}?r=makerlee`);
    expect(coinRefLink(COIN, null, ALICE, "https://www.disciple.vip")).toBe(`https://www.disciple.vip/rocket/robinhood/${COIN.toLowerCase()}?r=${ALICE}`);
    expect(coinRefLink(COIN, null, null, "https://www.disciple.vip")).toBe(`https://www.disciple.vip/rocket/robinhood/${COIN.toLowerCase()}`);
  });
});

describe("?r= first touch", () => {
  it("a wallet in ?r= counts like ?ref=", () => {
    expect(captureRefFromQuery(`?r=${ALICE}`)?.a).toBe(ALICE);
  });
  it("a username in ?r= resolves to its wallet", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ address: ALICE }), { status: 200 }));
    const t = await captureRefUsernameFromQuery("?r=Alice", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith("/api/profile/username?resolve=alice");
    expect(t).toMatchObject({ u: "alice", a: ALICE });
  });
  it("first touch still wins and unknown names write nothing", async () => {
    const none = vi.fn(async () => new Response(JSON.stringify({ address: null }), { status: 200 }));
    expect(await captureRefUsernameFromQuery("?r=nobody", none as unknown as typeof fetch)).toBeNull();
    expect(store[REF_LS]).toBeUndefined();
    captureRefFromQuery(`?r=${ALICE}`);
    const f = vi.fn();
    expect(await captureRefUsernameFromQuery("?r=bob", f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(currentRef()?.a).toBe(ALICE);
  });
});

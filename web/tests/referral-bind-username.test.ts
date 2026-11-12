/**
 * Username path of the account referral bind: a wallet-signed username claim or change (POST /api/profile/username)
 * also saves the browser's first-touch referrer to that wallet (lib/server/referralBind.bindWalletReferrer).
 * Same Rewardful / Impact first-touch-then-bind pattern and same Upstash keys as the Privy sign-in bind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const kvData = new Map<string, string>();
let failBind = false;
let slowBind = false;
const mem = {
  kind: "local" as const,
  async get(k: string) {
    if (k.includes(":bind:") && failBind) throw new Error("upstash down");
    if (k.includes(":bind:") && slowBind) await new Promise((r) => setTimeout(r, 5000));
    return kvData.get(k) ?? null;
  },
  async set(k: string, v: string) { kvData.set(k, v); },
  async setNX(k: string, v: string) { if (kvData.has(k)) return false; kvData.set(k, v); return true; },
};
vi.mock("@/lib/server/kv", () => ({ kv: () => mem }));

const names = new Map<string, string>(); // wallet -> username
vi.mock("@/lib/server/usernames", () => ({
  usernameOf: vi.fn(async (a: string) => names.get(a.toLowerCase()) ?? null),
  walletOf: vi.fn(async (u: string) => Array.from(names.entries()).find(([, n]) => n === u)?.[0] ?? null),
  claim: vi.fn(async (u: string, a: string) => { names.set(a.toLowerCase(), u); return { ok: true }; }),
}));
vi.mock("@/lib/server/nonces", () => ({
  nonceValid: vi.fn(async () => true), consumeNonce: vi.fn(async () => {}), issueNonce: vi.fn(async () => "n"),
}));
// The signature check is the existing one; here it just says "this wallet signed".
vi.mock("@/lib/server/chat/identity", () => ({ verifyWalletSignature: vi.fn(async (addr: string, _m: string, sig: string) => (sig === "good" ? addr : null)) }));
vi.mock("@/lib/server/profileMeta", () => ({ lastUsernameChangeAt: vi.fn(async () => null), markUsernameChange: vi.fn(async () => {}) }));
vi.mock("@/lib/server/inviteGate", () => ({ INVITE_REQUIRED_MESSAGE: "invite", requireInviteWallet: vi.fn(async () => ({ ok: true })) }));

import { BIND, accountReferrerOf, bindAccountReferrer, bindWalletReferrer, touchFromRequest } from "../lib/server/referralBind";
import { REF_COOKIE } from "../lib/referral";
import { POST } from "../app/api/profile/username/route";

const ME = "0x00000000000000000000000000000000000000aa";
const OWNER = "0x00000000000000000000000000000000000000ac";
const REF_1 = "0x00000000000000000000000000000000000000b1";
const REF_2 = "0x00000000000000000000000000000000000000b2";
const DID = "did:privy:abcdefgh1234";
const DAY = 86_400_000;
const touch = (a: string | null, u: string | null = null, t = Date.now() - DAY) => ({ u, a, t });
const cookieOf = (t: unknown) => `other=1; ${REF_COOKIE}=${encodeURIComponent(JSON.stringify(t))}`;

function post(body: Record<string, unknown>, cookie?: string) {
  return POST(new Request("https://x.test/api/profile/username", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ address: ME, nonce: "n", signature: "good", ...body }),
  }));
}

beforeEach(() => { kvData.clear(); names.clear(); failBind = false; slowBind = false; });

describe("POST /api/profile/username saves the first-touch referrer to the signed wallet", () => {
  it("first claim binds from the disciple_ref cookie", async () => {
    const r = await post({ username: "player1" }, cookieOf(touch(REF_1, "alice")));
    expect(await r.json()).toEqual({ ok: true });
    expect(names.get(ME)).toBe("player1");
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
    expect(Object.keys(JSON.parse(kvData.get(BIND.wallet(ME))!)).sort()).toEqual(["at", "r", "t"]);
  });

  it("first claim binds from the posted ref (browser currentRef) when there is no cookie", async () => {
    expect((await post({ username: "player1", ref: touch(REF_1) })).status).toBe(200);
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
  });

  it("a later username change never overwrites the saved referrer", async () => {
    await post({ username: "player1" }, cookieOf(touch(REF_1)));
    const r = await post({ username: "player2" }, cookieOf(touch(REF_2)));
    expect(await r.json()).toEqual({ ok: true });
    expect(names.get(ME)).toBe("player2");
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
  });

  it("refuses self-referral (the signed wallet or its smart-account owner) and the name still saves", async () => {
    expect(await (await post({ username: "player1" }, cookieOf(touch(ME)))).json()).toEqual({ ok: true });
    expect(await (await post({ username: "player2", owner: OWNER }, cookieOf(touch(OWNER)))).json()).toEqual({ ok: true });
    expect(names.get(ME)).toBe("player2");
    expect(kvData.has(BIND.wallet(ME))).toBe(false);
  });

  it("refuses a username-only touch, an expired touch, or junk, and the name still saves", async () => {
    expect((await post({ username: "player1" }, cookieOf(touch(null, "alice")))).status).toBe(200);
    expect((await post({ username: "player2" }, cookieOf(touch(REF_1, null, Date.now() - 31 * DAY)))).status).toBe(200);
    expect((await post({ username: "player3", ref: "junk" }, `${REF_COOKIE}=%7Bnope`)).status).toBe(200);
    expect(names.get(ME)).toBe("player3");
    expect(kvData.has(BIND.wallet(ME))).toBe(false);
  });

  it("username still succeeds when the bind store errors or hangs", async () => {
    failBind = true;
    expect(await (await post({ username: "player1" }, cookieOf(touch(REF_1)))).json()).toEqual({ ok: true });
    expect(names.get(ME)).toBe("player1");
    failBind = false; slowBind = true;
    const t0 = Date.now();
    expect(await (await post({ username: "player2" }, cookieOf(touch(REF_1)))).json()).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(names.get(ME)).toBe("player2");
  }, 10_000);

  it("a failed signature does not bind", async () => {
    expect((await post({ username: "player1", signature: "bad" }, cookieOf(touch(REF_1)))).status).toBe(401);
    expect(kvData.size).toBe(0);
  });

  it("stores no email, IP, or username of the player, only { r, t, at }", async () => {
    await POST(new Request("https://x.test/api/profile/username", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieOf(touch(REF_1, "alice")), "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ username: "player1", address: ME, nonce: "n", signature: "good" }),
    }));
    const all = Array.from(kvData.entries()).filter(([k]) => k.includes(":bind:")).map(([, v]) => v).join(" ");
    expect(all).not.toContain("203.0.113.9");
    expect(all).not.toContain("player1");
    expect(all).not.toContain("@");
  });
});

describe("both paths share the same keys (first write wins across them)", () => {
  it("a Privy sign-in after a username bind keeps the username-path referrer for the account", async () => {
    await bindWalletReferrer({ wallet: ME, touch: touch(REF_1) }, mem);
    const r = await bindAccountReferrer({ did: DID, wallets: [ME, OWNER], touch: touch(REF_2) }, mem);
    expect(r).toMatchObject({ ok: true, referrer: REF_1, bound: false });
    expect(await accountReferrerOf(OWNER, mem)).toBe(REF_1);
  });
  it("a username claim after a Privy bind keeps the Privy referrer", async () => {
    await bindAccountReferrer({ did: DID, wallets: [ME], touch: touch(REF_1) }, mem);
    await post({ username: "player1" }, cookieOf(touch(REF_2)));
    expect(await accountReferrerOf(ME, mem)).toBe(REF_1);
  });
  it("touchFromRequest: posted ref with a wallet first, else cookie", () => {
    expect(touchFromRequest(cookieOf(touch(REF_2)), touch(REF_1))?.a).toBe(REF_1);
    expect(touchFromRequest(cookieOf(touch(REF_2)), touch(null, "alice"))?.a).toBe(REF_2);
    expect(touchFromRequest(null, null)).toBeNull();
  });
});

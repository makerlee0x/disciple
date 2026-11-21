/**
 * Money flow: Add cash by card / Apple Pay (POST /api/cash/card). Who signs: nobody, the card seller pays USDC on Base
 * into a Relay deposit address. Where it lands: USDG in the signed-in pilot's own wallet on Robinhood Chain, never any
 * other address. Privy sign-in and Relay are stubbed; the route, its limits and the KV are real.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MINE = "0x929D22560c48d3240a7e35559810d58f3d2692aD";
const ALSO_MINE = "0x00000000000000000000000000000000000000a1";
const h = vi.hoisted(() => ({ signedIn: true, quotes: [] as Record<string, unknown>[] }));
vi.mock("@/lib/server/privyAuth", () => ({
  bearer: () => "tok",
  privyEnv: () => ({ appId: "x" }),
  authenticate: async () => (h.signedIn ? { ok: true, user: { id: "did:privy:1", emails: [], wallets: [MINE, ALSO_MINE] } } : { ok: false, status: 401 }),
}));

let POST: (req: Request) => Promise<Response>;
let ip = 0;
const env = { ...process.env };
beforeAll(async () => {
  process.env.KV_LOCAL_FILE = join(tmpdir(), `card-route-${Date.now()}-${Math.random()}.json`);
  process.env.TRUSTED_PROXY = "1";
  ({ POST } = await import("@/app/api/cash/card/route"));
});
beforeEach(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "4663";
  h.signedIn = true; h.quotes = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
    h.quotes.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ steps: [{ id: "deposit", depositAddress: "0x4444444444444444444444444444444444444444" }], details: { currencyOut: { amount: "24960000" } } }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); process.env.NEXT_PUBLIC_CHAIN_ID = env.NEXT_PUBLIC_CHAIN_ID; });

const req = (b: unknown, wallet: string | null = MINE, ipHdr = `10.9.0.${++ip}`) => new Request("http://x/api/cash/card", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok", "x-real-ip": ipHdr, ...(wallet ? { "x-wallet": wallet } : {}) }, body: JSON.stringify(b),
});

describe("POST /api/cash/card", () => {
  it("returns a Base USDC deposit address that pays USDG into the wallet asked for", async () => {
    const r = await POST(req({ usd: 25 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, address: "0x4444444444444444444444444444444444444444", chain: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", outUsd: 24.96 });
    expect(h.quotes[0]).toMatchObject({ user: MINE.toLowerCase(), recipient: MINE.toLowerCase(), refundTo: MINE.toLowerCase(), amount: "25000000" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("a second wallet on the same login is fine", async () => {
    const r = await POST(req({ usd: 25 }, ALSO_MINE));
    expect(r.status).toBe(200);
    expect(h.quotes[0].recipient).toBe(ALSO_MINE.toLowerCase());
  });

  it("never sends cash to a wallet this login doesn't own, and never falls back to another one", async () => {
    for (const w of ["0x000000000000000000000000000000000000dEaD", null, "not-an-address"]) {
      const r = await POST(req({ usd: 25 }, w));
      expect(r.status).toBe(403);
      expect((await r.json()).reason).toBe("That cash address isn't on this login.");
    }
    expect(h.quotes).toHaveLength(0);
  });

  it("signed out: sign in first", async () => {
    h.signedIn = false;
    const r = await POST(req({ usd: 25 }));
    expect(r.status).toBe(401);
    expect(h.quotes).toHaveLength(0);
  });

  it("$5 to $2,000 only, refused before Relay is asked", async () => {
    for (const usd of [4.99, 2000.01, "abc", null]) {
      const r = await POST(req({ usd }));
      expect(r.status).toBe(400);
      expect((await r.json()).reason).toBe("Pick $5 to $2000.");
    }
    expect(h.quotes).toHaveLength(0);
  });

  it("mainnet only: Relay has no Robinhood Chain testnet route", async () => {
    process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
    const r = await POST(req({ usd: 25 }));
    expect(r.status).toBe(409);
    expect(h.quotes).toHaveLength(0);
  });

  it("10 a minute per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await POST(req({ usd: 25 }, MINE, "10.8.8.8"))).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("Relay down: a plain line, no deposit address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 503 })));
    const r = await POST(req({ usd: 25 }));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j).toEqual({ ok: false, reason: "The swap service didn't answer." });
  });
});

// /users/:u/referral-coins: curve coins to settle in CurveFeeVault.claimReferrerFeesFor (hook rebuild, 2026-11-19).
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db";
import { Api } from "../src/api";
import type { Config } from "../src/config";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const cfg = { chainId: 1, rpcUrl: "", stateView: A(9), stacks: [], dbPath: ":memory:", port: 0, chunk: 100n, pollMs: 0, confirmations: 0, reorgDepth: 64, rpcRps: 0, minChunk: 1n } as unknown as Config;
const ME = A(0xa1), REF = A(0xb1), STRANGER = A(0xc1);
const T1 = A(0x101), T2 = A(0x102), T3 = A(0x103), T4 = A(0x104);

describe("referral coins", () => {
  it("lists curve coins my referrals traded plus my KOL coins, latest first, graduated left out", async () => {
    const db = openDb(":memory:");
    const coin = db.prepare("INSERT INTO coins (token, stack, curve, creator, quote, graduated) VALUES (?, 's', ?, ?, ?, ?)");
    coin.run(T1, A(1), A(2), A(3), 0); coin.run(T2, A(1), A(2), A(3), 0); coin.run(T3, A(1), A(2), A(3), 1); coin.run(T4, A(1), A(2), A(3), 0);
    db.prepare("INSERT INTO referrals (stack, wallet, referrer, status, block, ts, tx) VALUES ('s', ?, ?, 'attributed', 1, 1, '0x')").run(REF, ME);
    const trade = db.prepare("INSERT INTO trades (id, token, stack, source, trader, ts) VALUES (?, ?, 's', 'curve', ?, ?)");
    trade.run("a", T1, REF, 10); trade.run("b", T3, REF, 30); trade.run("c", T4, STRANGER, 40);
    db.prepare("INSERT INTO fee_credits VALUES ('k', 's', ?, ?, 1, ?, 'kol', '5', 1, 20, '0x')").run(T2, A(4), ME);
    const api = new Api(db, null, cfg);
    const [status, body] = await api.route("GET", new URL(`http://x/users/${ME}/referral-coins`));
    expect(status).toBe(200);
    expect((body as { tokens: string[] }).tokens).toEqual([T2, T1]);
  });
});

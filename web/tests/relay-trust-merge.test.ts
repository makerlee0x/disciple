/**
 * AUDIT r264 step 6 fix (verdict at 815af744): the trust-store save is an atomic MERGE, never a replace.
 * Two independent SenderTrust ledgers (= two serverless instances) share ONE KV (the real local Kv, in memory).
 * No network, no chain ops.
 */
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
  process.env.KV_LOCAL_FILE = `/tmp/relay-trust-merge-${process.pid}.json`;
  return {};
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({}) }));
import { kv, mergeTrust, TRUST_MERGE_LUA, type TrustMergeFields } from "../lib/server/kv";
import { SenderTrust, type TrustStore } from "../lib/server/relayTrust";
import { kvTrustStore } from "../lib/server/relayTrustStore";
import { requireNotRevokedOrStruck, strikeSource } from "../lib/server/relayLockdown";
void h;

const sender = "0x00000000000000000000000000000000000000aa";
const key = `relay:trust:${sender}`;
const T0 = 1_800_000_000_000;
/** What validateOp does with TRUST on an op (fastRelay: primeShared + simulated, then flush after the response). */
async function opOn(ledger: SenderTrust) { ledger.simulated(sender); await ledger.primeShared(sender, 10n ** 18n); await ledger.flush(); }
const gateOn = (ledger: SenderTrust, now: number) => { strikeSource.local = s => ledger.get(s)?.strikeUntil ?? 0; return requireNotRevokedOrStruck(sender, now); };

beforeEach(async () => { await kv().del(key); strikeSource.local = () => 0; });

describe("trust store save = atomic merge (AUDIT step 6)", () => {
  it("multi-instance wipe: a struck sender's op on instance B neither clears the strike nor lets the next op through", async () => {
    let now = T0; const clock = () => now;
    const A = new SenderTrust(clock, kvTrustStore()), B = new SenderTrust(clock, kvTrustStore());
    A.strike(sender); await A.flush();
    const struck = JSON.parse((await kv().get(key))!) as TrustMergeFields;
    expect(struck.strikes).toBe(1); expect(struck.strikeUntil).toBeGreaterThan(T0);
    now += 1000;
    // op 2 on B (never saw the sender): admission refuses, the speculative simulation still runs TRUST.simulated
    await expect(gateOn(B, now)).rejects.toMatchObject({ notSent: true, message: expect.stringContaining("strike backoff") });
    await opOn(B);
    const after = JSON.parse((await kv().get(key))!) as TrustMergeFields;
    expect(after.strikeUntil).toBe(struck.strikeUntil); expect(after.strikes).toBe(1); expect(after.lastStrikeAt).toBe(struck.lastStrikeAt);
    // op 3: refused on B, on A, and on a third cold instance C
    const C = new SenderTrust(clock, kvTrustStore());
    for (const L of [B, A, C]) await expect(gateOn(L, now + 1)).rejects.toMatchObject({ notSent: true });
    // B hydrated the strike into its own ledger too (stricter wins)
    expect(B.get(sender)?.strikeUntil).toBe(struck.strikeUntil);
    // after the window, ops are admitted again (no permanent lockout from the merge)
    await expect(gateOn(C, struck.strikeUntil + 1)).resolves.toBeNull();
  });

  it("the pre-fix replace store (DEL + SET NX) wipes the strike: the scenario above is the AUDIT bug", async () => {
    const replace: TrustStore = { ...kvTrustStore(), async save(s, p) { await kv().del(`relay:trust:${s}`); await kv().setNX(`relay:trust:${s}`, JSON.stringify(p), 60); } };
    let now = T0; const clock = () => now;
    const A = new SenderTrust(clock, replace), B = new SenderTrust(clock, replace);
    A.strike(sender); await A.flush(); now += 1000;
    B.simulated(sender); await B.flush();
    await expect(gateOn(B, now)).resolves.toBeNull();   // the bug: op 3 would go through
  });

  it("strikes never decrease through any save; a later stricter strike wins; verifiedAt/fastOps stay the caller's", async () => {
    let now = T0; const clock = () => now;
    const A = new SenderTrust(clock, kvTrustStore()), B = new SenderTrust(clock, kvTrustStore());
    A.strike(sender); A.strike(sender); await A.flush();                    // strikes 2
    const s2 = JSON.parse((await kv().get(key))!) as TrustMergeFields;
    now += 5000; B.strike(sender); await B.flush();                         // B's local view: strikes 1, but later
    const m = JSON.parse((await kv().get(key))!) as TrustMergeFields;
    expect(m.strikes).toBe(2); expect(m.lastStrikeAt).toBe(now); expect(m.strikeUntil).toBe(Math.max(s2.strikeUntil, B.get(sender)!.strikeUntil));
    now += 10; B.simulated(sender); await B.flush();
    const v = JSON.parse((await kv().get(key))!) as TrustMergeFields;
    expect(v.verifiedAt).toBe(now); expect(v.fastOps).toBe(0); expect(v.strikes).toBe(2); expect(v.strikeUntil).toBe(m.strikeUntil);
  });

  it("an unparseable stored entry is left in place (gate keeps failing closed); the save rejects and is swallowed", async () => {
    await kv().set(key, "{not json");
    const B = new SenderTrust(() => T0, kvTrustStore());
    B.simulated(sender); await B.flush();
    expect(await kv().get(key)).toBe("{not json");
    await expect(gateOn(B, T0)).rejects.toMatchObject({ notSent: true });
    expect(mergeTrust('{"verifiedAt":1}', { verifiedAt: 0, fastOps: 0, strikes: 0, lastStrikeAt: 0, strikeUntil: 0 })).toBeNull();
  });

  it("the key is never absent during a save (no DEL window for a concurrent admission MGET)", async () => {
    const A = new SenderTrust(() => T0, kvTrustStore());
    A.strike(sender); await A.flush();
    const s = kv(), del = vi.spyOn(s, "del"), setNX = vi.spyOn(s, "setNX");
    const B = new SenderTrust(() => T0 + 1, kvTrustStore());
    B.simulated(sender); const seen = (await s.mget([key]))[0]; await B.flush();
    expect(seen).not.toBeNull(); expect(del).not.toHaveBeenCalled(); expect(setNX).not.toHaveBeenCalled();
    del.mockRestore(); setNX.mockRestore();
  });

  // Upstash runs TRUST_MERGE_LUA. Parity with mergeTrust is checked under a real Lua 5.1 (lupa) when TRUST_LUA_PY names a
  // python with lupa installed (box-only tooling; skipped otherwise).
  it.skipIf(!process.env.TRUST_LUA_PY)("TRUST_MERGE_LUA (Lua 5.1) == mergeTrust on fixtures", () => {
    const cases: [string | null, TrustMergeFields][] = [
      [null, { verifiedAt: 5, fastOps: 1, strikes: 0, lastStrikeAt: 0, strikeUntil: 0 }],
      [JSON.stringify({ verifiedAt: 0, fastOps: 0, strikes: 3, lastStrikeAt: 1794249412710, strikeUntil: 1794249652710 }), { verifiedAt: 1794249413000, fastOps: 0, strikes: 0, lastStrikeAt: 0, strikeUntil: 0 }],
      [JSON.stringify({ verifiedAt: 9, fastOps: 4, strikes: 1, lastStrikeAt: 100, strikeUntil: 200 }), { verifiedAt: 0, fastOps: 0, strikes: 2, lastStrikeAt: 300, strikeUntil: 900 }],
      ["{not json", { verifiedAt: 1, fastOps: 0, strikes: 0, lastStrikeAt: 0, strikeUntil: 0 }],
      [JSON.stringify({ verifiedAt: 1 }), { verifiedAt: 1, fastOps: 0, strikes: 0, lastStrikeAt: 0, strikeUntil: 0 }],
    ];
    const py = `
import json, sys
from lupa import lua51
L = lua51.LuaRuntime()
script, cases = json.loads(sys.stdin.read())
out = []
for stored, p in cases:
    st = {"v": stored, "set": None}
    def call(cmd, *a):
        if cmd == "GET": return st["v"]
        if cmd == "SET": st["set"] = a[1]; return "OK"
    L.globals().redis = L.table_from({"call": lambda *a: call(*a), "error_reply": lambda m: "ERR"})
    L.globals().KEYS = L.table_from(["k"])
    L.globals().ARGV = L.table_from([str(p[f]) for f in ["verifiedAt","fastOps","strikes","lastStrikeAt","strikeUntil"]] + ["172800"])
    r = L.execute(script)
    out.append([r, st["set"]])
print(json.dumps(out))`;
    const res = JSON.parse(execFileSync(process.env.TRUST_LUA_PY!, ["-c", py], { input: JSON.stringify([TRUST_MERGE_LUA, cases]) }).toString()) as [number, string | null][];
    cases.forEach(([stored, p], i) => {
      const want = mergeTrust(stored, p);
      expect(res[i][0]).toBe(want ? 1 : 0);
      expect(res[i][1] === null ? null : JSON.parse(res[i][1]!)).toEqual(want);
    });
  });
});

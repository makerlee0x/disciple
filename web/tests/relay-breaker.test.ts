// Item a: relayer-loss circuit breaker (#245 residual). Happy path = zero store I/O on the request; losses trip it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kv } from "../lib/server/kv";
import { BREAKER_OPEN_KEY, RelayBreaker, breakerConfig, relayerNetWei } from "../lib/server/relayBreaker";
import { ENTRYPOINT_V07 } from "../lib/aa/constants";

function fakeKv() {
  const m = new Map<string, string>(); const calls: string[] = [];
  const store = {
    calls, m,
    async get(k: string) { calls.push(`get ${k}`); return m.get(k) ?? null; },
    async incrEx(k: string) { calls.push(`incrEx ${k}`); const n = Number(m.get(k) ?? 0) + 1; m.set(k, String(n)); return n; },
    async incrByEx(k: string, by: number) { calls.push(`incrByEx ${k}`); const n = Number(m.get(k) ?? 0) + by; m.set(k, String(n)); return n; },
    async setNX(k: string, v: string) { calls.push(`setNX ${k}`); if (m.has(k)) return false; m.set(k, v); return true; },
  };
  return store as typeof store & Kv;
}
const cfg = { ...breakerConfig({}), refreshMs: 2000 };
const UO = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const uoLog = (cost: bigint) => ({ address: ENTRYPOINT_V07, topics: [UO, "0x" + "11".repeat(32)], data: "0x" + word(1n) + word(1n) + word(cost) + word(400_000n) });

describe("relay loss breaker", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("defaults need no env; invalid overrides fall back to the defaults", () => {
    expect(breakerConfig({})).toMatchObject({ windowSec: 600, pauseSec: 900, revertTrip: 2, lossTripGwei: 100_000 });
    expect(breakerConfig({ RELAY_BREAKER_REVERTS: "0", RELAY_BREAKER_LOSS_GWEI: "-1" })).toMatchObject({ revertTrip: 2, lossTripGwei: 100_000 });
  });

  it("happy path: assertClosed is sync, does no awaited I/O, and a profitable receipt writes nothing", async () => {
    const st = fakeKv(); let t = 1_000_000; const b = new RelayBreaker(() => st, cfg, () => t);
    await b.refresh();
    st.calls.length = 0;
    for (let i = 0; i < 50; i++) { expect(() => b.assertClosed()).not.toThrow(); t += 10; }   // 500 ms < refreshMs
    expect(st.calls).toEqual([]);
    expect(await b.record({ reverted: false, lossWei: -1000n })).toBe(false);
    expect(await b.record({ reverted: false, lossWei: 0n })).toBe(false);
    expect(st.calls).toEqual([]);
    t += 2000; b.assertClosed(); expect(st.calls).toEqual([`get ${BREAKER_OPEN_KEY}`]);   // background refresh, not awaited
  });

  it("2 included reverts in the window trip it: this instance refuses notSent at once, others via the shared key", async () => {
    const st = fakeKv(); let t = 5_000_000; const a = new RelayBreaker(() => st, cfg, () => t), other = new RelayBreaker(() => st, cfg, () => t);
    expect(await a.record({ reverted: true, lossWei: 1n })).toBe(false);
    expect(() => a.assertClosed()).not.toThrow();
    expect(await a.record({ reverted: true, lossWei: 1n })).toBe(true);
    let err: unknown; try { a.assertClosed(); } catch (e) { err = e; }
    expect(err).toMatchObject({ notSent: true, paused: true, message: expect.stringMatching(/relay paused/) });
    await other.refresh(); expect(() => other.assertClosed()).toThrow(/relay paused/);
    t += cfg.pauseSec * 1000 + 1; expect(() => a.assertClosed()).not.toThrow();   // auto-closes after the pause
  });

  it("accumulated net loss beyond the threshold trips it (no revert needed)", async () => {
    const st = fakeKv(); const b = new RelayBreaker(() => st, cfg, () => 1);
    expect(await b.record({ reverted: false, lossWei: 60_000n * 10n ** 9n })).toBe(false);
    expect(await b.record({ reverted: false, lossWei: 40_000n * 10n ** 9n })).toBe(true);
    expect(b.isOpen()).toBe(true);
  });

  it("a store error on refresh keeps the last known state (an open breaker stays open)", async () => {
    const st = fakeKv(); let t = 10; const b = new RelayBreaker(() => st, { ...cfg, revertTrip: 1 }, () => t);
    await b.record({ reverted: true, lossWei: 0n });
    st.get = async () => { throw new Error("kv down"); };
    t += 5000; await b.refresh(); expect(b.isOpen()).toBe(true);
  });

  it("relayerNetWei = Σ UserOperationEvent.actualGasCost − gasUsed × effectiveGasPrice", () => {
    const rc = (status: string, logs: ReturnType<typeof uoLog>[]) => ({ status, gasUsed: "0x" + (500_000).toString(16), effectiveGasPrice: "0x" + (10n ** 7n).toString(16), logs });
    expect(relayerNetWei(rc("0x1", [uoLog(6n * 10n ** 12n)]), ENTRYPOINT_V07)).toBe(10n ** 12n);
    expect(relayerNetWei(rc("0x0", []), ENTRYPOINT_V07)).toBe(-5n * 10n ** 12n);
    expect(relayerNetWei({ status: "0x1", gasUsed: "0x1", logs: [] }, ENTRYPOINT_V07)).toBeUndefined();
    expect(relayerNetWei(rc("0x1", [{ ...uoLog(9n * 10n ** 12n), address: `0x${"22".repeat(20)}` as `0x${string}` }]), ENTRYPOINT_V07)).toBe(-5n * 10n ** 12n);
  });
});

describe("POST /api/bundler while the breaker is open", () => {
  it("refuses disciple_sendUserOperationSync notSent before streamRelay (nothing leased or signed); warm still answers", async () => {
    vi.resetModules();
    const streamRelay = vi.fn(), selfBundle = vi.fn(async () => ({ ok: true }));
    vi.doMock("@/lib/server/relayStream", () => ({ streamRelay }));
    vi.doMock("@/lib/server/selfBundler", () => ({ selfBundle }));
    vi.doMock("@/lib/server/relayLockdown", () => ({ requireSelfBundlerMode: () => undefined }));
    const st = fakeKv();
    vi.doMock("@/lib/server/kv", () => ({ kv: () => st }));
    vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
    const { relayBreaker } = await import("@/lib/server/relayBreaker");
    await relayBreaker.record({ reverted: true, lossWei: 0n }); await relayBreaker.record({ reverted: true, lossWei: 0n });
    const { POST } = await import("../app/api/bundler/route");
    const req = (method: string) => new Request("http://x/api/bundler", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [{}, "0x0000000071727De22E5E9d8BAf0edAc6f37da032"] }) });
    const res = await POST(req("disciple_sendUserOperationSync"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ code: -32003, message: expect.stringMatching(/relay paused/), data: { notSent: true } });
    expect(streamRelay).not.toHaveBeenCalled();
    expect((await POST(req("disciple_warm"))).status).toBe(200);
    vi.doUnmock("@/lib/server/relayStream"); vi.doUnmock("@/lib/server/selfBundler"); vi.doUnmock("@/lib/server/relayLockdown"); vi.doUnmock("@/lib/server/kv");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/server/fastRelay", () => ({ sendUserOperationSync: h.send }));
import { streamRelay } from "../lib/server/relayStream";
import { RelayMetrics, ImmutableRelayCache } from "../lib/server/relayMetrics";
const sym = Symbol.for("@vercel/request-context");
const global = globalThis as unknown as Record<symbol, unknown>;
const result = { kind: "confirmed", userOpHash: "0xop", txHash: "0xtx", success: true, receipt: { status: "0x1", logs: [] }, logs: [], t: { simulate: 110, signTx: 4, send: 211, mined: 0, total: 465 } };
const params = [{}, "0xentry", { pressId: "public-press" }];
afterEach(() => { delete global[sym]; vi.restoreAllMocks(); });
describe("confirmed stream handoff", () => {
  it("registers waitUntil before work, streams/closes before protected cleanup finishes", async () => {
    let release!: () => void; const post = new Promise<void>(r => { release = r; });
    let background!: Promise<unknown>;
    const wu = vi.fn((p: Promise<unknown>) => { background = p; }); global[sym] = { get: () => ({ waitUntil: wu }) };
    h.send.mockImplementation(async (_op, _pending, _before, _metrics, confirmed) => {
      expect(wu).toHaveBeenCalledOnce(); confirmed(result); await post; return result;
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = new RelayMetrics(), response = streamRelay(params, async () => undefined, undefined, undefined, m);
    const reader = response.body!.getReader(), frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('"kind":"confirmed"');
    expect((await reader.read()).done).toBe(true); expect(m.snapshot().confirmedFrameEnqueued).toBeGreaterThanOrEqual(0);
    let done = false; void background.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    release(); await background;
    expect(m.snapshot().postWorkComplete).toBeGreaterThanOrEqual(m.snapshot().confirmedFrameEnqueued);
  });
  it("without waitUntil retains awaited cleanup before emitting", async () => {
    let release!: () => void; const post = new Promise<void>(r => { release = r; });
    h.send.mockImplementation(async (_op, _pending, _before, _metrics, confirmed) => { expect(confirmed).toBeUndefined(); await post; return result; });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const reader = streamRelay(params, async () => undefined).body!.getReader(); let read = false;
    const frame = reader.read().then(r => { read = true; return r; }); await Promise.resolve(); await Promise.resolve(); expect(read).toBe(false);
    release(); expect(new TextDecoder().decode((await frame).value)).toContain('"kind":"confirmed"');
  });
  it("post-receipt cleanup failure cannot turn a mined confirmation into rollback", async () => {
    let background!: Promise<unknown>; global[sym] = { get: () => ({ waitUntil: (p: Promise<unknown>) => { background = p; } }) };
    h.send.mockImplementation(async (_op, _pending, _before, _metrics, confirmed) => { confirmed(result); throw new Error("store offline"); });
    vi.spyOn(console, "info").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const text = await streamRelay(params, async () => undefined).text(); await background;
    expect(text).toContain('"kind":"confirmed"'); expect(text).not.toContain('"kind":"error"');
  });
});
describe("immutable-only cache and stage metrics", () => {
  it("expires, bounds, and never retains negative/error reads", async () => {
    let now = 0; const cache = new ImmutableRelayCache(30, () => now), read = vi.fn().mockResolvedValue("known");
    await cache.get("k", read, v => v === "known"); await cache.get("k", read, v => v === "known"); expect(read).toHaveBeenCalledOnce();
    now = 31; await cache.get("k", read, () => true); expect(read).toHaveBeenCalledTimes(2);
    const zero = vi.fn().mockResolvedValue("zero"); await cache.get("z", zero, () => false); await cache.get("z", zero, () => false); expect(zero).toHaveBeenCalledTimes(2);
    const bad = vi.fn().mockRejectedValue(new Error("offline")); await expect(cache.get("e", bad, () => true)).rejects.toThrow(); await expect(cache.get("e", bad, () => true)).rejects.toThrow(); expect(bad).toHaveBeenCalledTimes(2);
  });
  it("records monotonic overlapping spans without claiming their sum is elapsed", async () => {
    let now = 0; const m = new RelayMetrics(() => now); await Promise.all([m.span("authLogin", async () => { now = 10; }), m.span("sessionRead", async () => { now = 20; })]);
    m.mark("confirmedFrameEnqueued"); expect(m.snapshot().elapsed).toBe(20); expect(m.snapshot().authLogin).toBe(20);
  });
});

it("local confirmed-frame timing before/after, mocked 465ms core and 60ms release", async () => {
  vi.useFakeTimers(); const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  try {
    const run = async (protect: boolean): Promise<Record<string, number | undefined>> => {
      let background: Promise<unknown> | undefined;
      if (protect) global[sym] = { get: () => ({ waitUntil: (p: Promise<unknown>) => { background = p; } }) }; else delete global[sym];
      const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
      h.send.mockImplementation(async (_op, _pending, _before, metrics: RelayMetrics, confirmed) => {
        await sleep(465); metrics.mark("receiptReady"); confirmed?.(result);
        await metrics.span("leaseRelease", () => sleep(60)); return result;
      });
      const m = new RelayMetrics(Date.now), reader = streamRelay(params, async () => undefined, undefined, undefined, m).body!.getReader();
      let frameMs: number | undefined; const start = Date.now(); const read = reader.read().then(r => { frameMs = Date.now() - start; return r; });
      await vi.advanceTimersByTimeAsync(525); await read; await background;
      return { confirmedFrame: frameMs, ...m.snapshot() };
    };
    const before = await run(false), after = await run(true);
    expect(before.confirmedFrame).toBe(525); expect(after.confirmedFrame).toBe(465);
    expect(before.leaseRelease).toBe(60); expect(after.leaseRelease).toBe(60); expect(after.postWorkComplete).toBe(525);
    info.mockRestore(); console.info("LOCAL_STREAM_BENCHMARK " + JSON.stringify({ before, after, basis: "mocked core465/release60; same cleanup, protected earlier frame, no chain ops" }));
  } finally { vi.useRealTimers(); }
});

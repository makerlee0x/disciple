/**
 * Money flow: a real-money Climb run is saved on the server (lib/server/climbRecord). The browser only notes the run
 * (level, stake, window); after the buzzer the server reads the pilot's own Lighter fills, scores them itself and puts a
 * clear on the Climb board with its SP. Lighter is stubbed; the KV, the board and the SP are the real code.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const h = vi.hoisted(() => ({ fills: [] as unknown[] | null, fail: false, calls: 0 }));
vi.mock("@/lib/server/lighter/history", () => ({
  fillsOf: async () => { h.calls++; if (h.fail) throw new Error("lighter down"); return h.fills; },
}));

let rec: typeof import("@/lib/server/climbRecord");
let modes: typeof import("@/lib/server/seasonModes");
let kvMod: typeof import("@/lib/server/kv");
const env = { ...process.env };
let n = 0;
const pid = () => `0x${(++n).toString(16).padStart(40, "0")}`;

beforeAll(async () => {
  process.env.KV_LOCAL_FILE = join(tmpdir(), `climb-save-${Date.now()}-${Math.random()}.json`);
  rec = await import("@/lib/server/climbRecord");
  modes = await import("@/lib/server/seasonModes");
  kvMod = await import("@/lib/server/kv");
});
beforeEach(() => { process.env.LIGHTER_ENABLED = "1"; h.fills = []; h.fail = false; h.calls = 0; });
afterEach(() => { if (env.LIGHTER_ENABLED === undefined) delete process.env.LIGHTER_ENABLED; else process.env.LIGHTER_ENABLED = env.LIGHTER_ENABLED; });

const now = Date.now();
const run = (level: number, stake: number) => ({ level, stake, startAt: now - 70_000, endAt: now - 10_000 });
const fill = (dt: number, usd: number, pnl: number | null, fee = 0.001) => ({ kind: "fill", at: now - 70_000 + dt, market: "BTC", usd, fee, pnl });
const onBoard = async (w: string) => (await modes.climbBoard(500)).find((r) => r.wallet === w.toLowerCase());
const sp = async (w: string) => (await modes.modeSp("climb", 1000))[w.toLowerCase()] ?? 0;

describe("settleClimbRun", () => {
  it("a run that hits level 1's goal goes on the Climb board with its time and pays SP", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-a", run(1, 12));
    h.fills = [fill(5_000, 120, null), fill(30_000, 120, 0.15)];
    const r = await rec.settleClimbRun(w, "run-a");
    expect(r).toMatchObject({ cleared: 1, clearMs: 30_000 });
    expect(await onBoard(w)).toEqual({ wallet: w, climbLevel: 1, clearMs: 30_000 });
    expect(await sp(w)).toBeGreaterThan(0);
  });

  it("a miss saves nothing", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-b", run(1, 12));
    h.fills = [fill(5_000, 120, null), fill(30_000, 120, 0.05)];
    expect((await rec.settleClimbRun(w, "run-b"))?.cleared).toBe(0);
    expect(await onBoard(w)).toBeUndefined();
    expect(await sp(w)).toBe(0);
  });

  it("scored once: a second settle (cron sweep, retry) finds nothing and pays nothing more", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-c", run(1, 12));
    h.fills = [fill(1_000, 120, null), fill(20_000, 120, 0.2)];
    await rec.settleClimbRun(w, "run-c");
    const before = await sp(w);
    expect(await rec.settleClimbRun(w, "run-c")).toBeNull();
    expect(await sp(w)).toBe(before);
    expect(h.calls).toBe(1);
  });

  it("a level cleared again the same season pays no second SP but a faster time still moves the board", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-d1", run(1, 12));
    h.fills = [fill(1_000, 120, null), fill(40_000, 120, 0.2)];
    await rec.settleClimbRun(w, "run-d1");
    const first = await sp(w);
    await rec.noteClimbRun(w, "run-d2", run(1, 12));
    h.fills = [fill(1_000, 120, null), fill(10_000, 120, 0.2)];
    await rec.settleClimbRun(w, "run-d2");
    expect(await sp(w)).toBe(first);
    expect((await onBoard(w))?.clearMs).toBe(10_000);
  });

  it("Lighter not answering keeps the run for a retry instead of losing it", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-e", run(1, 12));
    h.fail = true;
    await expect(rec.settleClimbRun(w, "run-e")).rejects.toThrow("lighter down");
    h.fail = false;
    h.fills = [fill(1_000, 120, null), fill(20_000, 120, 0.2)];
    expect((await rec.settleClimbRun(w, "run-e"))?.cleared).toBe(1);
  });

  it("noting a run twice keeps the first one (a re-arm can't swap in an easier stake)", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-f", run(1, 12));
    await rec.noteClimbRun(w, "run-f", run(1, 2));
    // +$0.05 would clear a $2 stake (goal $0.02) but not the $12 one first noted (goal $0.12)
    h.fills = [fill(1_000, 20, null), fill(20_000, 20, 0.05)];
    const r = await rec.settleClimbRun(w, "run-f");
    expect(r?.stake).toBe(12);
    expect(r?.cleared).toBe(0);
  });

  it("free mode (after level 5) and an unknown run are never scored", async () => {
    const { CLIMB_FREE } = await import("@/lib/climb/rules");
    const w = pid();
    await rec.noteClimbRun(w, "run-g", run(CLIMB_FREE, 100));
    h.fills = [fill(1_000, 120, null), fill(20_000, 120, 50)];
    expect(await rec.settleClimbRun(w, "run-g")).toBeNull();
    expect(await rec.settleClimbRun(w, "never-armed")).toBeNull();
    expect(h.calls).toBe(0);
    expect(await onBoard(w)).toBeUndefined();
  });

  it("no Turbo account yet: nothing to score", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-h", run(1, 12));
    h.fills = null;
    expect(await rec.settleClimbRun(w, "run-h")).toBeNull();
  });

  it("with Lighter off nothing is read or written", async () => {
    const w = pid();
    await rec.noteClimbRun(w, "run-i", run(1, 12));
    delete process.env.LIGHTER_ENABLED;
    expect(await rec.settleClimbRun(w, "run-i")).toBeNull();
    expect(h.calls).toBe(0);
    process.env.LIGHTER_ENABLED = "1";
    expect(await kvMod.kv().get(`climb:run:testnet:${w}:run-i`)).not.toBeNull();
  });
});

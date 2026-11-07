import { logPreSendNetwork } from "../lib/aa/diagnostics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowTiming, beginFlowTiming, flowTimingReady } from "../lib/trade/flowTiming";
import { relaySend } from "../lib/aa/relayClient";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  let now = 10;
  const frames: (() => void)[] = [], tasks: { cb: () => void; ms: number }[] = [], logs: Record<string, unknown>[] = [];
  const f = new FlowTiming({ now: () => now, frame: cb => { frames.push(cb); }, later: (cb, ms) => { tasks.push({ cb, ms }); }, log: row => { logs.push(row); } });
  return { f, logs, at: (n: number) => { now = n; }, frame: () => { frames.splice(0).forEach(cb => cb()); }, flush: () => { tasks.splice(0).filter(t => t.ms === 0).forEach(t => t.cb()); }, timeout: () => { tasks.splice(0).forEach(t => t.cb()); } };
}
const receipt = { userOpHash: "0xop", txHash: "0xtx", t: { simulate: 7, signTx: 2, send: 30, mined: 0, total: 50 } };
describe("passive flow timing", () => {
  it("binds a tap to its press and logs once only after two pending/fill frames", () => {
    const x = fixture(), s = x.f.begin("buy", 1); s.bind("p"); s.pendingPaint();
    x.at(16); x.frame(); expect(x.logs).toEqual([]); x.at(32); x.frame();
    x.at(100); x.f.receipt("p", receipt); x.f.fill("p"); s.finish(true); x.flush(); expect(x.logs).toEqual([]);
    x.at(112); x.frame(); x.at(128); x.frame(); expect(x.logs).toEqual([]); x.flush();
    expect(x.logs).toHaveLength(1); expect(x.logs[0]).toMatchObject({ pressId: "p", side: "buy", ok: true, tapToPaint: 31, tapToReceipt: 99, tapToFill: 127, server: receipt.t, userOpHash: "0xop", txHash: "0xtx" });
    s.finish(false, "rollback"); x.timeout(); expect(x.logs).toHaveLength(1);
  });
  it("isolates concurrent taps and keeps the first terminal receipt", () => {
    const x = fixture(), a = x.f.begin("buy", 0), b = x.f.begin("sell", 20); a.bind("a"); b.bind("b");
    x.at(30); x.f.receipt("b", receipt); x.at(40); x.f.receipt("a", { ...receipt, txHash: "0xa" }); x.at(50); x.f.receipt("b", { ...receipt, txHash: "0xwrong" });
    a.finish(false); b.finish(false); x.flush();
    expect(x.logs.map(r => [r.pressId, r.tapToReceipt, r.txHash])).toEqual([["a", 40, "0xa"], ["b", 10, "0xtx"]]);
  });
  it("never calls pending a fill and emits a rollback failure", () => {
    const x = fixture(), s = x.f.begin("buy"); s.bind("p"); s.pendingPaint(); x.at(15); x.frame(); x.at(20); x.frame(); x.flush(); expect(x.logs).toEqual([]);
    s.finish(false, "rollback"); s.finish(false); x.flush(); expect(x.logs[0]).toMatchObject({ ok: false, reason: "rollback", tapToReceipt: null, tapToFill: null });
  });
  it("reports paint as null when background-tab rAF never runs", () => {
    const x = fixture(), s = x.f.begin("sell"); s.bind("p"); s.pendingPaint(); x.f.receipt("p", receipt); x.f.fill("p"); s.finish(true);
    x.timeout(); expect(x.logs[0]).toMatchObject({ ok: true, tapToPaint: null, tapToFill: null });
  });
  it("reports a pre-admission failure without inventing a press id", () => {
    const x = fixture(), s = x.f.begin("buy"); s.finish(false, "alert"); x.flush(); expect(x.logs[0]).toMatchObject({ pressId: null, ok: false, userOpHash: null, txHash: null });
  });
  it("cannot throw through trade callbacks when telemetry scheduling fails", () => {
    const f = new FlowTiming({ now: () => 0, frame: () => { throw Error("frame"); }, later: () => { throw Error("timer"); }, log: () => { throw Error("console"); } });
    const s = f.begin("buy"); expect(() => { s.bind("p"); s.pendingPaint(); f.receipt("p", receipt); f.fill("p"); s.finish(false); }).not.toThrow();
  });
});

it("records receipt consumption from a mocked NDJSON response without any real send", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockReturnValue(200);
  const info = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const s = beginFlowTiming("buy", 10); s.bind("wire-test");
  const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ kind: "confirmed", success: true, ...receipt }) + "\n", { headers: { "content-type": "application/x-ndjson" } }));
  const answer = await relaySend("https://example.invalid/api/bundler", {}, "0x01", undefined, fakeFetch as typeof fetch, { pressId: "wire-test" });
  expect(answer.result?.txHash).toBe("0xtx"); expect(fakeFetch).toHaveBeenCalledOnce();
  s.finish(false); vi.advanceTimersByTime(0);
  expect(info).toHaveBeenCalledOnce(); expect(info.mock.calls[0]).toHaveLength(1); expect(info.mock.calls[0][0]).toMatch(/^\[disciple\] flow timing /);
  expect(JSON.parse(String(info.mock.calls[0][0]).slice("[disciple] flow timing ".length))).toMatchObject({ pressId: "wire-test", tapToReceipt: 190, server: receipt.t, userOpHash: "0xop", txHash: "0xtx" });
});

it("does not invent a pending paint when rollback wins before the paint opportunity", () => {
  const x = fixture(), s = x.f.begin("buy"); s.bind("fast-fail"); s.pendingPaint(); s.finish(false, "rollback");
  x.at(16); x.frame(); x.at(32); x.frame(); x.flush();
  expect(x.logs).toHaveLength(1); expect(x.logs[0]).toMatchObject({ ok: false, tapToPaint: null, tapToFill: null });
});


it("reports a hung/ambiguous press without settling it and still reports later confirmation", () => {
  let now = 0; const tasks: { cb: () => void; ms: number }[] = [], rows: Record<string, unknown>[] = [];
  const f = new FlowTiming({ now: () => now, frame: cb => cb(), later: (cb, ms) => { tasks.push({ cb, ms }); }, log: row => { rows.push(row); } });
  const s = f.begin("buy", 0); s.bind("hung"); s.bind("hung"); s.pendingPaint();
  expect(tasks.filter(t => t.ms === 15000)).toHaveLength(1);
  s.identify({ userOpHash: "0xknown" });
  now = 15000; tasks.find(t => t.ms === 15000)!.cb();
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ pressId: "hung", ok: null, terminal: false, reason: "unresolved", elapsedMs: 15000, userOpHash: "0xknown", txHash: null, tapToFill: null });
  tasks.find(t => t.ms === 15000)!.cb(); expect(rows).toHaveLength(1);
  now = 16000; f.receipt("hung", receipt); f.fill("hung"); s.finish(true);
  tasks.filter(t => t.ms === 0).forEach(t => t.cb());
  expect(rows).toHaveLength(2); expect(rows[1]).toMatchObject({ ok: true, tapToReceipt: 16000, txHash: "0xtx" });
});

it("offers a one-string error-console mount probe without creating or sending a trade", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  flowTimingReady(); expect(log).toHaveBeenCalledWith('[disciple] flow timing ready {"version":2,"bridge":"installed"}');
});

it("keeps pre-send diagnostics redacted and cannot alter retries if console fails", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logPreSendNetwork("transport", "quote", new Error("HTTP request failed https://example.invalid/secret-path Bearer fake-auth"));
  expect(log.mock.calls[0]).toHaveLength(1);
  const line = String(log.mock.calls[0][0]); expect(line).toContain('"notSent":true'); expect(line).toContain('"read":"quote"');
  expect(line).not.toContain("example.invalid"); expect(line).not.toContain("fake-auth");
  log.mockImplementation(() => { throw Error("collector failed"); });
  expect(() => logPreSendNetwork("sdk-incomplete", "build", Error("missing fields"))).not.toThrow();
});

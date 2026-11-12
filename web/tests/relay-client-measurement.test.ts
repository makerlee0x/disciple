import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowTiming, sendFlowBeacon, flowPointer, flowClick, takeFlowClick, clearFlowPointer } from "../lib/trade/flowTiming";
import { cleanFlowTelemetry, FLOW_FIELDS } from "../lib/trade/flowTelemetry";
import { OwnLedger, TRANSFER_TOPIC } from "../lib/flight/ownLedger";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearFlowPointer(); });
describe("post-render beacon", () => {
  it("starts at pointerdown, not delayed click/bridge", () => {
    vi.spyOn(performance, "now").mockReturnValue(100); flowPointer(90);
    vi.mocked(performance.now).mockReturnValue(5000); flowClick(); expect(takeFlowClick()).toBe(90);
    flowClick(); expect(takeFlowClick()).toBe(5000);
  });
  it("records all spans/counters and sends once only after committed done plus paint", () => {
    let now = 10; const frames: (() => void)[] = [], tasks: (() => void)[] = []; const beacon = vi.fn();
    const f = new FlowTiming({ now: () => now, frame: cb => { frames.push(cb); }, later: cb => { tasks.push(cb); }, log: () => {}, beacon });
    const span = f.begin("buy", 1); span.bind("press-test-1"); f.cache("press-test-1", "quote", true); f.cache("press-test-1", "allowance", false);
    for (const mark of ["requestStart", "firstByte", "pendingFrame", "confirmedFrame", "applyOwnStart", "applyOwnEnd"] as const) { now += 10; f.mark("press-test-1", mark); }
    span.finish(true); tasks.splice(0).forEach(cb => cb()); expect(beacon).not.toHaveBeenCalled();
    f.doneRendered("press-test-1"); frames.splice(0).forEach(cb => cb()); tasks.splice(0).forEach(cb => cb()); expect(beacon).not.toHaveBeenCalled();
    now = 200; frames.splice(0).forEach(cb => cb()); tasks.splice(0).forEach(cb => cb()); expect(beacon).toHaveBeenCalledOnce();
    expect(beacon.mock.calls[0][0]).toMatchObject({ ok: true, tapToRequestStart: 19, tapToApplyOwnEnd: 69, tapToDoneRender: 199, cache: { quote: { hit: 1, miss: 0 }, allowance: { hit: 0, miss: 1 } } });
    f.doneRendered("press-test-1"); span.finish(true); tasks.splice(0).forEach(cb => cb()); expect(beacon).toHaveBeenCalledOnce();
  });
  it("never beacons an unresolved press or suspended background render", () => {
    const tasks: (() => void)[] = [], beacon = vi.fn();
    const f = new FlowTiming({ now: () => 0, frame: () => {}, later: cb => { tasks.push(cb); }, log: () => {}, beacon });
    const span = f.begin("sell"); span.bind("press-hung-1"); tasks.splice(0).forEach(cb => cb()); expect(beacon).not.toHaveBeenCalled();
    span.finish(false); f.doneRendered("press-hung-1"); tasks.splice(0).forEach(cb => cb()); expect(beacon).not.toHaveBeenCalled();
  });
  it("never beacons after the 4337 self-bundler path was removed, and never throws", () => {
    const sendBeacon = vi.fn().mockReturnValue(false); vi.stubGlobal("navigator", { sendBeacon });
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production"); sendFlowBeacon({}); expect(sendBeacon).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview"); sendFlowBeacon({}); expect(sendBeacon).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", "self"); sendFlowBeacon({}); expect(sendBeacon).not.toHaveBeenCalled();
    sendBeacon.mockImplementation(() => { throw Error("disabled"); }); expect(() => sendFlowBeacon({})).not.toThrow();
  });
});
it("strictly redacts untrusted payload, invalid numbers, identifiers and unknown keys", () => {
  const good = { version: 3, pressId: "press-test-1", side: "buy", ok: true, ...Object.fromEntries(FLOW_FIELDS.map(k => [k, 12])), cache: { quote: { hit: 1, miss: 0 }, balance: { hit: 1, miss: 0 }, allowance: { hit: 1, miss: 0 } }, token: "secret", server: { key: "secret" } };
  expect(JSON.stringify(cleanFlowTelemetry(good))).not.toContain("secret");
  expect(cleanFlowTelemetry({ ...good, tapToDoneRender: null })).toBeNull();
  expect(cleanFlowTelemetry({ ...good, tapToFirstByte: NaN })).toBeNull();
  expect(cleanFlowTelemetry({ ...good, pressId: "\nforged log" })).toBeNull();
  expect(cleanFlowTelemetry({ ...good, cache: { quote: { hit: 1, miss: -1 } } })).toBeNull();
});
it("receipt ledger deduplicates replay after another fill and cannot fetch a baseline", () => {
  const l = new OwnLedger(), owner = "0x" + "11".repeat(20), token = "0x" + "22".repeat(20), other = "0x" + "33".repeat(20);
  const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const logs = [{ address: token, topics: [TRANSFER_TOPIC, topic(other), topic(owner)], data: "0x0a" }];
  const baseline = vi.fn(() => 100n);
  l.applyFill(owner, [token], logs, "0xa", baseline, 0); l.applyFill(owner, [token], logs, "0xb", baseline, 1);
  expect(l.get(token, owner)).toBe(120n); expect(l.applyFill(owner, [token], logs, "0xa", baseline, 2)).toEqual([]); expect(l.get(token, owner)).toBe(120n);
});

it("actual receipt wiring contains no awaited balance/account/cache read before fill/done", () => {
  const source = readFileSync(new URL("../components/TradeBridge.tsx", import.meta.url), "utf8");
  const apply = source.slice(source.indexOf("    const applyOwn ="), source.indexOf("    const bookReceipt ="));
  expect(apply).not.toMatch(/\bawait\b|balanceHint\(|syncCache\(|activeAddress\(/);
  expect(apply).toContain("OWN.applyFill"); expect(apply).toContain("receiptCacheWork.current.set"); expect(apply).toContain("syncReceiptBalance");
  const protocol = readFileSync(new URL("../lib/protocol-viem.ts", import.meta.url), "utf8");
  const cas = protocol.slice(protocol.indexOf("export function syncReceiptBalance"), protocol.indexOf("/** Balance hint"));
  expect(cas).toContain("current === observed"); expect(cas).not.toMatch(/\bawait\b|readContract|balanceHint/);
});

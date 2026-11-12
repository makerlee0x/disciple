/** Funnel client (SITE draft, lib/funnelClient.ts): each step at most once per browser, return_d1 on the next UTC day,
 *  never throws, sends only { step }. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeTrackReturn, trackFunnel } from "@/lib/funnelClient";

let store: Record<string, string> = {};
let sent: string[] = [];
beforeEach(() => {
  store = {}; sent = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  vi.stubGlobal("navigator", { sendBeacon: (_u: string, b: Blob) => { void b.text().then((t) => sent.push(t)); return true; } });
});
afterEach(() => vi.unstubAllGlobals());
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("trackFunnel", () => {
  it("sends each step once per browser, body is only the step", async () => {
    trackFunnel("land"); trackFunnel("land"); trackFunnel("first_trade"); trackFunnel("first_trade");
    await flush();
    expect(sent).toEqual([JSON.stringify({ step: "land" }), JSON.stringify({ step: "first_trade" })]);
  });
  it("return_d1 only on the UTC day after the land day", async () => {
    store["disciple:fun:landday"] = "2026-11-10";
    maybeTrackReturn(Date.parse("2026-11-10T23:00:00Z")); await flush();
    expect(sent).toEqual([]);
    maybeTrackReturn(Date.parse("2026-11-12T01:00:00Z")); await flush();
    expect(sent).toEqual([]);
    maybeTrackReturn(Date.parse("2026-11-11T08:00:00Z")); await flush();
    expect(sent).toEqual([JSON.stringify({ step: "return_d1" })]);
  });
  it("fails silently: no storage, or the network throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => trackFunnel("signin")).not.toThrow();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("navigator", { sendBeacon: () => { throw new Error("x"); } });
    expect(() => trackFunnel("fund")).not.toThrow();
  });
});

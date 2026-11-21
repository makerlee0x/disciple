import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, liveSocket } from "@/lib/net/liveSocket";
import { lighterIds, streamLighterBook } from "@/lib/turbo/royalePrices";

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0; sent: string[] = []; closed = false;
  onopen: null | (() => void) = null; onmessage: null | ((e: { data: string }) => void) = null;
  onclose: null | (() => void) = null; onerror: null | (() => void) = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(d: unknown) { this.onmessage?.({ data: JSON.stringify(d) }); }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.readyState = 3; }
}

// a tiny window/document so the wake listeners have somewhere to live
const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible" });

beforeEach(() => {
  FakeWS.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("liveSocket", () => {
  it("backoff doubles from 0.5 s, stays inside ±25 %, and caps", () => {
    expect(backoffMs(0, 8000, () => 0.5)).toBe(500);
    expect(backoffMs(3, 8000, () => 0.5)).toBe(4000);
    expect(backoffMs(9, 8000, () => 0.5)).toBe(8000);
    expect(backoffMs(0, 8000, () => 0)).toBe(375);
    expect(backoffMs(0, 8000, () => 1)).toBe(625);
  });

  it("drops a socket that goes quiet without closing (network hand-off) and dials again", () => {
    const got: string[] = [];
    const s = liveSocket({ url: () => "wss://x", onMessage: (d) => got.push(d), staleMs: 8000, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const a = FakeWS.all[0]; a.open(); a.msg({ p: 1 });
    expect(s.open()).toBe(true);
    vi.advanceTimersByTime(12_100); // no frames: the watchdog fires
    expect(a.closed).toBe(true);
    vi.advanceTimersByTime(700); // first retry is ~0.5 s
    expect(FakeWS.all.length).toBe(2);
    FakeWS.all[1].open(); FakeWS.all[1].msg({ p: 2 });
    expect(got).toEqual(['{"p":1}', '{"p":2}']);
    s.stop();
  });

  it("keeps a chatty socket, re-subscribes on every reconnect, and sends pings", () => {
    const opens: number[] = [];
    const s = liveSocket({ url: () => "wss://x", onOpen: () => opens.push(1), onMessage: () => {}, ping: "PING", pingMs: 2000, staleMs: 8000, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const a = FakeWS.all[0]; a.open();
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(2000); a.msg({ pong: 1 }); }
    expect(a.closed).toBe(false);
    expect(a.sent.filter((x) => x === "PING").length).toBeGreaterThan(5);
    a.onclose?.(); // the server hangs up
    vi.advanceTimersByTime(700);
    FakeWS.all[1].open();
    expect(opens.length).toBe(2);
    s.stop();
  });

  it("reconnects at once when the phone comes back online, without waiting out a long backoff", () => {
    const s = liveSocket({ url: () => "wss://x", onMessage: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    // fail a few times so the backoff is long
    for (let i = 0; i < 5; i++) { const w = FakeWS.all.at(-1)!; w.onclose?.(); vi.advanceTimersByTime(9000); }
    const before = FakeWS.all.length;
    FakeWS.all.at(-1)!.onclose?.();
    win.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(1);
    expect(FakeWS.all.length).toBe(before + 1);
    s.stop();
  });

  it("coming back to the front replaces a socket that went quiet in the background", () => {
    const s = liveSocket({ url: () => "wss://x", onMessage: () => {}, staleMs: 15_000, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const a = FakeWS.all[0]; a.open(); a.msg({});
    vi.advanceTimersByTime(5000); // quiet 5 s, under the watchdog
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1);
    expect(a.closed).toBe(true);
    expect(FakeWS.all.length).toBe(2);
    s.stop();
  });

  it("stop() closes everything and never dials again", () => {
    const s = liveSocket({ url: () => "wss://x", onMessage: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    s.stop();
    FakeWS.all[0].onclose?.();
    win.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.all.length).toBe(1);
  });
});

describe("Lighter book on a flaky network", () => {
  it("retries the market id lookup instead of leaving the book off for the visit", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) throw new TypeError("Load failed");
      return { json: async () => ({ order_book_details: [{ symbol: "BTC", market_id: 1 }] }) };
    });
    const stop = streamLighterBook("BTC", () => {}, "flaky.example");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.all.length).toBe(0); // lookup failed, no socket yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(FakeWS.all.length).toBe(1);
    FakeWS.all[0].open();
    expect(JSON.parse(FakeWS.all[0].sent[0])).toEqual({ type: "subscribe", channel: "order_book/1" });
    // a good answer is kept: a second stream doesn't fetch again
    await lighterIds("flaky.example");
    expect(calls).toBe(2);
    stop();
  });
});

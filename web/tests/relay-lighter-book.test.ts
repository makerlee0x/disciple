import { describe, expect, it, vi } from "vitest";
import { streamLighterBook } from "@/lib/turbo/royalePrices";

class FakeWS {
  static last: FakeWS | null = null;
  sent: string[] = []; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void;
  constructor(public url: string) { FakeWS.last = this; }
  send(s: string) { this.sent.push(s); }
  close() {}
}

describe("streamLighterBook", () => {
  it("subscribes to the coin's book and emits the mid as levels change", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    vi.stubGlobal("fetch", async () => ({ json: async () => ({ order_book_details: [{ symbol: "ETH", market_id: 0 }, { symbol: "BTC", market_id: 1 }] }) }));
    const mids: number[] = [];
    const stop = streamLighterBook("BTC", (m) => mids.push(m), "h.example");
    await new Promise((r) => setTimeout(r, 0));
    const ws = FakeWS.last!; expect(ws.url).toBe("wss://h.example/stream");
    ws.onopen!();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "subscribe", channel: "order_book/1" });
    ws.onmessage!({ data: JSON.stringify({ type: "subscribed/order_book", order_book: { bids: [{ price: "100.0", size: "1" }, { price: "99.0", size: "2" }], asks: [{ price: "102.0", size: "1" }] } }) });
    ws.onmessage!({ data: JSON.stringify({ type: "update/order_book", order_book: { bids: [{ price: "101.0", size: "0.5" }], asks: [] } }) });
    ws.onmessage!({ data: JSON.stringify({ type: "update/order_book", order_book: { bids: [{ price: "101.0", size: "0" }], asks: [{ price: "102.0", size: "0" }, { price: "104.0", size: "3" }] } }) });
    expect(mids).toEqual([101, 101.5, 102]);
    stop(); vi.unstubAllGlobals();
  });
});

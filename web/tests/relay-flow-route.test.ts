import { beforeEach, expect, it, vi } from "vitest";
const gate = vi.hoisted(() => vi.fn());
vi.mock("../lib/server/relayLockdown", () => ({ requireSelfBundlerMode: gate }));
const body = () => JSON.stringify({ version: 3, pressId: "press-test-1", side: "sell", ok: true, tapToPaint: 12, tapToRequestStart: 20, tapToFirstByte: 30, tapToPendingFrame: 30, tapToConfirmedFrame: 50, tapToApplyOwnStart: 51, tapToApplyOwnEnd: 52, tapToDoneRender: 70, cache: { quote: { hit: 1, miss: 0 }, balance: { hit: 1, miss: 0 }, allowance: { hit: 1, miss: 0 } }, secret: "never-log-me" });
beforeEach(() => { gate.mockReset(); vi.restoreAllMocks(); });
it("uses the existing fail-closed helper before reading or logging", async () => {
  const { POST } = await import("../app/api/aa/flow-timing/route"); gate.mockImplementation(() => { throw Error("Production blocked"); });
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  expect((await POST(new Request("https://preview.invalid/api/aa/flow-timing", { method: "POST", body: body() }))).status).toBe(404); expect(log).not.toHaveBeenCalled();
});
it("logs one sanitized line and rejects cross-origin or oversized content", async () => {
  const { POST } = await import("../app/api/aa/flow-timing/route"); const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const request = (body: string, origin = "https://preview.invalid") => new Request(origin + "/api/aa/flow-timing", { method: "POST", headers: { origin: "https://preview.invalid" }, body });
  expect((await POST(request(body()))).status).toBe(204); expect(log).toHaveBeenCalledOnce(); expect(String(log.mock.calls[0][0])).toMatch(/^\[disciple\] client flow timing /); expect(String(log.mock.calls[0][0])).not.toContain("never-log-me");
  expect((await POST(request(body(), "https://other.invalid"))).status).toBe(403);
  expect((await POST(request("x".repeat(5000)))).status).toBe(413); expect(log).toHaveBeenCalledOnce();
});

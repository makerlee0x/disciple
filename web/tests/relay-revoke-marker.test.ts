/** AUDIT r264 hardening 5 (M4): the revocation tooling's marker write. fetch is mocked; no network, no chain ops. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVOKE_MARKER_TTL_SEC, revokeMarkerKey, writeRevokeMarker } from "../lib/relayRevokeMarker";

afterEach(() => vi.unstubAllGlobals());
describe("relay revoke marker", () => {
  it("writes SET relay:revoked:<sender> <at> EX 600 to the shared KV", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: "OK" }) });
    vi.stubGlobal("fetch", fetch);
    await writeRevokeMarker("0xAbC0000000000000000000000000000000000011", { KV_REST_API_URL: "https://kv.invalid", KV_REST_API_TOKEN: "t" } as never, 123);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(["SET", "relay:revoked:0xabc0000000000000000000000000000000000011", "123", "EX", String(REVOKE_MARKER_TTL_SEC)]);
    expect(REVOKE_MARKER_TTL_SEC).toBe(600); expect(revokeMarkerKey("0xAB")).toBe("relay:revoked:0xab");
  });
  it("no shared KV configured or a failed write ⇒ throws (the tooling STOPs before any on-chain revoke)", async () => {
    await expect(writeRevokeMarker("0x11", {} as never)).rejects.toThrow("not configured");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(writeRevokeMarker("0x11", { UPSTASH_REDIS_REST_URL: "https://kv.invalid", UPSTASH_REDIS_REST_TOKEN: "t" } as never)).rejects.toThrow("write failed");
  });
});

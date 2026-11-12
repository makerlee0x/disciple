/** AUDIT r264 hardening 5 (M4): the revocation tooling's marker write. fetch is mocked; no network, no chain ops. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVOKE_MARKER_TTL_SEC, revokeMarkerKey, banKey, writeRevokeMarker } from "../lib/relayRevokeMarker";

afterEach(() => vi.unstubAllGlobals());
describe("relay revoke marker", () => {
  it("writes a permanent ban (no EX) and the 600 s marker, for wallet and did, in one pipeline", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ result: "OK" }, { result: "OK" }, { result: "OK" }, { result: "OK" }] });
    vi.stubGlobal("fetch", fetch);
    const wallet = "0xAbC0000000000000000000000000000000000011", did = "did:privy:tester000001";
    await writeRevokeMarker(wallet, { KV_REST_API_URL: "https://kv.invalid", KV_REST_API_TOKEN: "t" } as never, 123, did);
    expect(fetch.mock.calls[0][0]).toMatch(/\/pipeline$/);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual([
      ["SET", "relay:banned:0xabc0000000000000000000000000000000000011", "123"],
      ["SET", "relay:revoked:0xabc0000000000000000000000000000000000011", "123", "EX", String(REVOKE_MARKER_TTL_SEC)],
      ["SET", "relay:banned:did:privy:tester000001", "123"],
      ["SET", "relay:revoked:did:privy:tester000001", "123", "EX", String(REVOKE_MARKER_TTL_SEC)],
    ]);
    expect(REVOKE_MARKER_TTL_SEC).toBe(600);
    expect(revokeMarkerKey("0xAB")).toBe("relay:revoked:0xab");
    expect(banKey("0xAB")).toBe("relay:banned:0xab");
    expect(banKey(did)).toBe("relay:banned:did:privy:tester000001");
  });
  it("wallet-only revoke still writes a permanent ban + 600 s marker (no did)", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ result: "OK" }, { result: "OK" }] });
    vi.stubGlobal("fetch", fetch);
    await writeRevokeMarker("0xAbC0000000000000000000000000000000000011", { KV_REST_API_URL: "https://kv.invalid", KV_REST_API_TOKEN: "t" } as never, 123);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual([
      ["SET", "relay:banned:0xabc0000000000000000000000000000000000011", "123"],
      ["SET", "relay:revoked:0xabc0000000000000000000000000000000000011", "123", "EX", String(REVOKE_MARKER_TTL_SEC)],
    ]);
  });
  it("no shared KV configured or a failed write ⇒ throws (the tooling STOPs before any on-chain revoke)", async () => {
    await expect(writeRevokeMarker("0x11", {} as never)).rejects.toThrow("not configured");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(writeRevokeMarker("0x11", { UPSTASH_REDIS_REST_URL: "https://kv.invalid", UPSTASH_REDIS_REST_TOKEN: "t" } as never)).rejects.toThrow("write failed");
  });
});

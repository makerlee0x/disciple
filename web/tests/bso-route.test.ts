import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/server/gasSponsorship", () => ({ bsoPolicyId: () => "d38ec347-5eb0-498f-ba1a-842ea308c332", checkSponsoredOperation: vi.fn(async () => undefined) }));
vi.mock("../lib/server/alchemyKey", () => ({ alchemyKey: () => "test-key-not-a-credential" }));
vi.mock("../lib/server/kv", () => ({ kv: () => ({}) }));
vi.mock("../lib/server/inviteGate", () => ({ requireInviteWallet: async () => ({ ok: true }), inviteRequiredRpc: vi.fn() }));
vi.mock("../lib/server/limits", () => ({ BUNDLER_LIMITS: { simPerIp: { limit: 10, windowSec: 60 } }, clientIp: () => "local", hitLimit: async () => ({ ok: true }), sendLimiter: () => ({ pre: async () => null, peek: async () => null, beforeSend: async () => undefined }) }));
vi.mock("../lib/server/prepaidPaymaster", () => ({ assertPrepaidReady: vi.fn(() => { throw Error("legacy must not run"); }), configuredPrepaidPaymaster: vi.fn() }));
import { POST } from "../app/api/bundler/route";
import { checkSponsoredOperation } from "../lib/server/gasSponsorship";
import { assertPrepaidReady } from "../lib/server/prepaidPaymaster";
const upstream = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", upstream); upstream.mockReset(); vi.mocked(checkSponsoredOperation).mockReset().mockResolvedValue(); });
it("uses only server policy header for send and estimate, without PM readiness", async () => {
  for (const method of ["eth_sendUserOperation", "eth_estimateUserOperationGas"]) {
    upstream.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }), { status: 200 }));
    const body = { jsonrpc: "2.0", id: 1, method, params: [{ sender: "0x1111111111111111111111111111111111111111" }, "0x0000000071727De22E5E9d8BAf0edAc6f37da032"] };
    expect((await POST(new Request("http://localhost/api/bundler", { method: "POST", headers: { "x-alchemy-policy-id": "attacker" }, body: JSON.stringify(body) }))).status).toBe(200);
    const [, options] = upstream.mock.calls.at(-1)!;
    expect(options.headers["x-alchemy-policy-id"]).toBe("d38ec347-5eb0-498f-ba1a-842ea308c332");
    expect(JSON.parse(options.body)).toEqual(body);
  }
  expect(assertPrepaidReady).not.toHaveBeenCalled();
});
it("fails closed on denied calldata, before forwarding", async () => {
  vi.mocked(checkSponsoredOperation).mockRejectedValueOnce(Error("denied"));
  const r = await POST(new Request("http://localhost/api/bundler", { method: "POST", body: JSON.stringify({ method: "eth_sendUserOperation", params: [{ sender: "0x1234" }, "0x1234"] }) }));
  expect(r.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
});
it.each(["pm_getPaymasterData", "alchemy_requestGasAndPaymasterAndData", "eth_sendRawTransaction"])("never forwards %s", async (method) => {
  const r = await POST(new Request("http://localhost/api/bundler", { method: "POST", body: JSON.stringify({ method, params: [] }) }));
  expect(r.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
});

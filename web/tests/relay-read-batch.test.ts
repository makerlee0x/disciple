import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createPublicClient } from "viem";
import { relayReadTransport } from "../lib/server/relayReadTransport";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
type Req = { id: number; method: string; params?: unknown[] };
async function fixture(rejectBatch = false, rejectCall = false) {
  const seen: (Req | Req[])[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Req | Req[]; seen.push(body);
    res.setHeader("content-type", "application/json");
    if (Array.isArray(body) && rejectBatch) { res.statusCode = 400; res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch unsupported" } })); return; }
    const answer = (x: Req) => rejectCall && x.method === "eth_call"
      ? { jsonrpc: "2.0", id: x.id, error: { code: 3, message: "execution reverted: AA24 signature error", data: "0x1234" } }
      : { jsonrpc: "2.0", id: x.id, result: x.method === "eth_chainId" ? "0xb626" : x.method === "eth_blockNumber" ? "0x10" : "0x" };
    res.end(JSON.stringify(Array.isArray(body) ? body.map(answer).reverse() : answer(body)));
  });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no mock port");
  return { seen, client: createPublicClient({ transport: relayReadTransport(1000, 0, `http://127.0.0.1:${address.port}`) }) };
}
describe("fresh relay read JSON-RPC batching (mock server only, no chain)", () => {
  it("batches independent methods without changing params and routes responses by id", async () => {
    const { client, seen } = await fixture();
    const [chain, code] = await Promise.all([client.getChainId(), client.getCode({ address: "0x0000000000000000000000000000000000000011", blockTag: "pending" })]);
    expect(chain).toBe(46630); expect(code).toBeUndefined();
    expect(seen).toHaveLength(1); expect(Array.isArray(seen[0])).toBe(true);
    const batch = seen[0] as Req[];
    expect(batch.map(x => x.method).sort()).toEqual(["eth_chainId", "eth_getCode"]);
    expect(batch.find(x => x.method === "eth_getCode")?.params).toEqual(["0x0000000000000000000000000000000000000011", "pending"]);
  });
  it("keeps the working scalar path when the endpoint does not support batches", async () => {
    const { client, seen } = await fixture(true);
    expect(await client.getChainId()).toBe(46630);
    expect(seen.some(Array.isArray)).toBe(true); expect(seen.some(x => !Array.isArray(x))).toBe(true);
  });
  it("does not turn an EntryPoint simulation revert into a successful scalar retry", async () => {
    const { client, seen } = await fixture(false, true);
    await expect(client.call({ to: "0x0000000000000000000000000000000000000011", data: "0x1234", blockTag: "pending" })).rejects.toThrow("AA24");
    expect(seen).toHaveLength(1); expect(Array.isArray(seen[0])).toBe(true);
  });
  it("batches only explicit read methods; never raw transaction submission", () => {
    const source = readFileSync(new URL("../lib/server/relayReadTransport.ts", import.meta.url), "utf8");
    const list = source.slice(source.indexOf("const READS"), source.indexOf("export function"));
    expect(list).not.toContain("eth_sendRawTransaction"); expect(list).not.toContain("eth_sendTransaction");
  });
});

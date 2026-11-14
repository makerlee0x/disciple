#!/usr/bin/env node
/**
 * Stand-in chain for the end-to-end suite (e2e/). A tiny JSON-RPC server that answers the reads the site makes, so
 * pages render the same way every run with no network: chain id 46630 (Robinhood Chain testnet, the default build),
 * a block number that ticks, empty logs, and eth_call answers by selector (USDG balanceOf from the balances a test
 * sets, decimals 6, everything else a zero word). Writes (eth_sendRawTransaction) are refused, so a test can never
 * move real money even if an env var points somewhere it shouldn't.
 *
 * Control endpoints (tests only):
 *   POST /__e2e/balance {address, usd}  set that wallet's USDG balance (any token's balanceOf answers it)
 *   POST /__e2e/reset                   clear balances
 *   GET  /__e2e/calls                   counts per method + selector, for debugging
 *
 *   node e2e/support/mock-chain.mjs [port]   (default 8545, or E2E_CHAIN_PORT)
 */
import http from "node:http";

const PORT = Number(process.argv[2] || process.env.E2E_CHAIN_PORT || 8545);
const CHAIN_ID = Number(process.env.E2E_CHAIN_ID || 46630);
const balances = new Map(); // lowercased address -> bigint (6 decimals)
const calls = new Map();
const started = Date.now();
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const ZERO = word(0);
const hex = (v) => "0x" + BigInt(v).toString(16);
const block = () => Math.floor((Date.now() - started) / 250) + 1_000_000;

function ethCall(params) {
  const tx = (params && params[0]) || {};
  const data = String(tx.data || tx.input || "0x");
  const sel = data.slice(0, 10).toLowerCase();
  count(`eth_call ${sel}`);
  switch (sel) {
    case "0x70a08231": { // balanceOf(address)
      const who = "0x" + data.slice(34, 74).toLowerCase();
      return word(balances.get(who) ?? 0n);
    }
    case "0x313ce567": return word(6);                 // decimals()
    case "0x18160ddd": return word(10n ** 27n);         // totalSupply()
    case "0xdd62ed3e": return word(0);                  // allowance(owner, spender)
    default: return ZERO;
  }
}

function count(k) { calls.set(k, (calls.get(k) || 0) + 1); }

function answer(req) {
  const { id = null, method, params } = req || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  if (method !== "eth_call") count(method);
  switch (method) {
    case "eth_chainId": return ok(hex(CHAIN_ID));
    case "net_version": return ok(String(CHAIN_ID));
    case "eth_blockNumber": return ok(hex(block()));
    case "eth_getBlockByNumber": case "eth_getBlockByHash": {
      const n = block();
      return ok({ number: hex(n), hash: word(n), parentHash: word(n - 1), timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: "0x1", gasLimit: hex(30_000_000), gasUsed: "0x0",
        miner: "0x" + "0".repeat(40), transactions: [], difficulty: "0x0", extraData: "0x", logsBloom: "0x" + "0".repeat(512), nonce: "0x0000000000000000", sha3Uncles: word(0), size: "0x0", stateRoot: word(0), receiptsRoot: word(0), transactionsRoot: word(0), uncles: [] });
    }
    case "eth_call": return ok(ethCall(params));
    case "eth_getLogs": return ok([]);
    case "eth_getBalance": return ok("0x0");
    case "eth_getCode": return ok("0x");
    case "eth_getTransactionCount": return ok("0x0");
    case "eth_gasPrice": case "eth_maxPriorityFeePerGas": return ok("0x1");
    case "eth_estimateGas": return ok(hex(100_000));
    case "eth_feeHistory": return ok({ oldestBlock: hex(block() - 1), baseFeePerGas: ["0x1", "0x1"], gasUsedRatio: [0], reward: [["0x1"]] });
    case "eth_getTransactionReceipt": case "eth_getTransactionByHash": return ok(null);
    case "eth_sendRawTransaction": case "eth_sendTransaction":
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "e2e stand-in chain: writes are disabled" } };
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `e2e stand-in chain: ${method} not supported` } };
  }
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && req.url === "/__e2e/calls") return json(res, 200, Object.fromEntries(calls));
  if (req.method === "GET") return json(res, 200, { ok: true, chainId: CHAIN_ID });
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body; try { body = JSON.parse(raw || "null"); } catch { return json(res, 400, { error: "bad json" }); }
    if (req.url === "/__e2e/balance") {
      const a = String(body?.address || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return json(res, 400, { error: "bad address" });
      balances.set(a, BigInt(Math.round(Number(body.usd || 0) * 1e6)));
      return json(res, 200, { ok: true });
    }
    if (req.url === "/__e2e/reset") { balances.clear(); calls.clear(); return json(res, 200, { ok: true }); }
    json(res, 200, Array.isArray(body) ? body.map(answer) : answer(body));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`e2e stand-in chain on http://127.0.0.1:${PORT} (chain ${CHAIN_ID})`));

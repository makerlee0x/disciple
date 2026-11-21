/**
 * Always-on trade relay (maker 2026-11-21: "just move the trade relay onto an always on server"). One long-running
 * Node process serving the SAME JSON-RPC as POST /api/gasless (lib/server/gaslessRpc), so a trade never lands on a
 * cold Vercel copy: the RPC / sequencer / Upstash connections, relayer leases, nonces, base fee and Privy keys stay hot.
 *
 * Runs on Fly.io (relay/fly.toml). The site sends here when NEXT_PUBLIC_GASLESS_RELAY_URL is set and the last ping
 * answered; otherwise it uses /api/gasless on Vercel exactly as before.
 * Routes: POST /api/gasless · OPTIONS (CORS preflight) · GET /health.
 */
import http from "node:http";
import { Agent, setGlobalDispatcher } from "undici";
import { handleGaslessRpc } from "@/lib/server/gaslessRpc";
import { keepRelayHot } from "@/lib/server/fastRelay";
import { privyEnv, verificationKeys } from "@/lib/server/privyAuth";

// Node's fetch drops an idle connection after 4 s by default; keep RPC / sequencer / Upstash connections for a minute so
// a tap never pays a TLS handshake (the keep-hot tick below also touches them every few seconds).
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 64 }));

const PORT = Number(process.env.PORT) || 8080;
const ORIGINS = new Set((process.env.RELAY_ALLOWED_ORIGINS || "https://www.disciple.vip,https://disciple.vip").split(",").map((s) => s.trim()).filter(Boolean));
const MAX_BODY = 64 * 1024;
const HOT_MS = Math.max(1000, Number(process.env.RELAY_HOT_MS) || 2000);

function cors(origin: string | undefined): Record<string, string> {
  if (!origin || !ORIGINS.has(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, privy-id-token", "access-control-max-age": "600", vary: "origin" };
}

const server = http.createServer(async (req, res) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const ch = cors(origin);
  try {
    if (req.method === "GET" && req.url === "/health") { res.writeHead(200, { "content-type": "text/plain", ...ch }); res.end("ok"); return; }
    if (req.method === "OPTIONS") { res.writeHead(ch["access-control-allow-origin"] ? 204 : 403, ch); res.end(); return; }
    if (req.method !== "POST" || !req.url?.startsWith("/api/gasless")) { res.writeHead(404); res.end(); return; }
    if (origin && !ch["access-control-allow-origin"]) { res.writeHead(403); res.end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) { res.writeHead(413); res.end(); return; } chunks.push(c as Buffer); }
    // Real client IP: only Fly's edge header is trusted (a client-sent x-real-ip / x-forwarded-for is dropped).
    const h = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "x-real-ip" && k !== "x-forwarded-for") h.set(k, v);
    const ip = req.headers["fly-client-ip"];
    if (typeof ip === "string" && ip) h.set("x-real-ip", ip);
    const out = await handleGaslessRpc(new Request(`http://relay${req.url}`, { method: "POST", headers: h, body: Buffer.concat(chunks) }));
    res.writeHead(out.status, { "content-type": "application/json", ...ch });
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error("[relay] request failed", (e as Error).message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", ...ch });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "relay error", data: { notSent: true } } }));
  }
});
server.keepAliveTimeout = 65_000;   // browsers reuse the connection between taps
server.headersTimeout = 66_000;

let hot = false;
async function tick() {
  if (hot) return; hot = true;
  try { await Promise.allSettled([keepRelayHot(), verificationKeys(privyEnv())]); } finally { hot = false; }
}
server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT} (origins: ${[...ORIGINS].join(", ")})`);
  void tick(); setInterval(() => void tick(), HOT_MS).unref();
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });

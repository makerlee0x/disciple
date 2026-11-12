/**
 * AUDIT r264 hardening 5 (M4) + off-chain login H1/M1 (aa5ec0e1 follow-up, lee 8:25 PM CT Nov 9):
 *
 *  - relay:revoked:<wallet|did> — the original 10-min (TTL 600) marker. KEEP: the self-bundler still
 *    checks on-chain LoginGate, and this marker is the in-flight + PVE_LOGIN_CACHE_TTL (10 min) bridge
 *    until that on-chain revoke is authoritative. Written by the revocation tooling BEFORE its on-chain
 *    revoke (scripts/revocation-fixture-probe.mts).
 *  - relay:banned:<wallet> and relay:banned:<privyDid> — permanent (no EX). The off-chain gasless path
 *    no longer consults LoginGate, so the 600 s marker alone would let a revoked player back in. Revoke
 *    writes both ban keys (did optional if the tooling doesn't have it). The gasless (and self-bundler)
 *    gate reads them in the same MGET, fail closed.
 *
 * Convention only: an on-chain revoke sent outside our tooling never writes these (window accepted by
 * lee, 12:21 CT Nov 9).
 */
export const REVOKE_MARKER_TTL_SEC = 600;
export const revokeMarkerKey = (id: string) => `relay:revoked:${id.toLowerCase()}`;
export const banKey = (id: string) => `relay:banned:${id.toLowerCase()}`;

/** Upstash REST SET / pipeline with the same env names lib/server/kv uses. Never logs the URL or token.
 * Throws when the shared store is not configured: tooling must STOP before any on-chain revoke in that case. */
export async function writeRevokeMarker(sender: string, env: NodeJS.ProcessEnv = process.env, at = Date.now(), did?: string): Promise<void> {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, tok = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error("revoke marker: shared KV not configured (STOP before revoking)");
  const ts = String(at);
  const ids = did ? [sender, did] : [sender];
  const cmds: (string | number)[][] = [];
  for (const id of ids) {
    cmds.push(["SET", banKey(id), ts]);                                      // permanent ban, no EX
    cmds.push(["SET", revokeMarkerKey(id), ts, "EX", String(REVOKE_MARKER_TTL_SEC)]); // 600 s bridge (self-bundler)
  }
  const endpoint = cmds.length > 1 ? String(url).replace(/\/$/, "") + "/pipeline" : url;
  const body = cmds.length > 1 ? cmds : cmds[0];
  const res = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
  const j = (await res.json().catch(() => null)) as { result?: unknown } | { result?: unknown }[] | null;
  const ok = Array.isArray(j) ? j.length === cmds.length && j.every(x => x?.result === "OK") : j?.result === "OK";
  if (!res.ok || !ok) throw new Error(`revoke marker: write failed (HTTP ${res.status})`);
}

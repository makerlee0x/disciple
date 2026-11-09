/**
 * AUDIT r264 hardening 5 (M4): the relay revoke marker. Shared by the relay (lib/server/relayLockdown: read in admission
 * and again under the sender lease alongside the generation fence) and the revocation tooling
 * (scripts/revocation-fixture-probe.mts), which writes it BEFORE sending its on-chain revoke.
 * Presence ⇒ the relay refuses every op for that sender. TTL covers the in-flight window plus the PVE login cache
 * (BondingCurve PVE_LOGIN_CACHE_TTL, 10 min); after that the on-chain revoke is authoritative.
 * Convention only: an on-chain revoke sent outside our tooling never writes it (window accepted by lee, 12:21 CT Nov 9).
 */
export const REVOKE_MARKER_TTL_SEC = 600;
export const revokeMarkerKey = (sender: string) => `relay:revoked:${sender.toLowerCase()}`;

/** Upstash REST `SET key value EX ttl` with the same env names lib/server/kv uses. Never logs the URL or token.
 * Throws when the shared store is not configured: tooling must STOP before any on-chain revoke in that case. */
export async function writeRevokeMarker(sender: string, env: NodeJS.ProcessEnv = process.env, at = Date.now()): Promise<void> {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, tok = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error("revoke marker: shared KV not configured (STOP before revoking)");
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(["SET", revokeMarkerKey(sender), String(at), "EX", String(REVOKE_MARKER_TTL_SEC)]) });
  const j = (await res.json().catch(() => null)) as { result?: unknown } | null;
  if (!res.ok || j?.result !== "OK") throw new Error(`revoke marker: write failed (HTTP ${res.status})`);
}

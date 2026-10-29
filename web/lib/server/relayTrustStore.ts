import "server-only";
/**
 * Shared, durable store for the fast-relay trust ledger (lib/server/relayTrust). AUDIT Low: the ledger was a
 * per-process Map, so strikes and the "verified" state were lost on every restart / cold serverless instance (and the
 * first op on each new instance could skip simulation). Backed by kv() (Upstash in production; the local store in dev).
 * Keys: relay:trust:<sender> (JSON, 48 h TTL), relay:trust:first:<sender> (SET NX, no TTL).
 */
import { kv } from "./kv";
import type { PersistedTrust, TrustStore } from "./relayTrust";
import { STRIKE_DECAY_MS } from "./relayTrust";

const TTL_SEC = Math.ceil((2 * STRIKE_DECAY_MS) / 1000);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function kvTrustStore(): TrustStore {
  return {
    async load(sender) {
      const raw = await kv().get(`relay:trust:${sender}`);
      if (!raw) return null;
      const j = JSON.parse(raw) as Partial<PersistedTrust>;
      return { verifiedAt: num(j.verifiedAt), fastOps: num(j.fastOps), strikes: num(j.strikes), lastStrikeAt: num(j.lastStrikeAt), strikeUntil: num(j.strikeUntil) };
    },
    async save(sender, p) {
      const s = kv(), k = `relay:trust:${sender}`;
      // Kv has no SET EX; del + setNX(ttl) keeps the TTL (a lost race only drops one write: the in-memory state is still authoritative here)
      await s.del(k); await s.setNX(k, JSON.stringify(p), TTL_SEC);
    },
    async claimFirstPrime(sender) { return kv().setNX(`relay:trust:first:${sender}`, "1"); },
  };
}

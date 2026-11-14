import "server-only";
/**
 * Web push without a dependency: payload-less pushes signed with VAPID (RFC 8292, ES256 JWT). The service worker
 * (public/push-sw.js) wakes on the push and fetches the message from /api/push/latest, so nothing has to be encrypted
 * for the push service. Needs VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point) and VAPID_PRIVATE_KEY
 * (base64url, 32 bytes); generate a pair with `node scripts/vapid-keys.mjs`. VAPID_SUBJECT defaults to the site.
 */
import { createPrivateKey, sign } from "crypto";

export type PushSub = { endpoint: string };

/** push services the browsers use; anything else is refused (the server POSTs to this URL) */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^(web\.push|[a-z0-9-]+\.push)\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try { const u = new URL(endpoint); return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

const b64u = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function vapidKeys(env: NodeJS.ProcessEnv = process.env): { pub: string; priv: string; subject: string } | null {
  const pub = env.VAPID_PUBLIC_KEY?.trim(), priv = env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return null;
  if (fromB64u(pub).length !== 65 || fromB64u(priv).length !== 32) return null;
  return { pub, priv, subject: env.VAPID_SUBJECT?.trim() || "https://disciple.vip" };
}

/** the VAPID Authorization header for one push service origin (valid 12h) */
export function vapidAuth(endpoint: string, k: { pub: string; priv: string; subject: string }, now = Date.now()): string {
  const p = fromB64u(k.pub);
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: k.priv, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) }, format: "jwk" });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: k.subject })));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.pub}`;
}

/** "gone": the subscription expired or was revoked (drop it). */
export async function sendPush(sub: PushSub, k: NonNullable<ReturnType<typeof vapidKeys>>): Promise<"ok" | "gone" | "error"> {
  try {
    if (!validEndpoint(sub.endpoint)) return "gone";
    const r = await fetch(sub.endpoint, { method: "POST", headers: { authorization: vapidAuth(sub.endpoint, k), ttl: "86400", urgency: "normal", "content-length": "0" }, signal: AbortSignal.timeout(5000) });
    if (r.status === 404 || r.status === 410) return "gone";
    return r.ok ? "ok" : "error";
  } catch { return "error"; }
}

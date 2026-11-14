import "server-only";
/**
 * Apple push (APNs) for the DISCIPLE iPhone app, token-based auth (an ES256 JWT from a .p8 key), no dependency.
 * Off until these are set in Vercel (Apple Developer → Keys → new key with "Apple Push Notifications service"):
 *   APNS_KEY_ID     the key's 10-character id
 *   APNS_TEAM_ID    the team id (Membership page)
 *   APNS_KEY_P8     the .p8 file contents ("\n"-escaped is fine)
 *   APNS_BUNDLE_ID  optional, default vip.disciple.app (mobile/capacitor.config.ts appId)
 * Device tokens carry their environment (TestFlight and App Store builds are "production", Xcode runs are "sandbox"),
 * so each saved device remembers which host to use.
 */
import { connect, constants, type ClientHttp2Session } from "http2";
import { createPrivateKey, sign } from "crypto";

export type ApnsEnv = "production" | "sandbox";
export type ApnsKeys = { keyId: string; teamId: string; p8: string; bundleId: string };

export const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/;
export const validApnsToken = (t: unknown): t is string => typeof t === "string" && APNS_TOKEN_RE.test(t);

export function apnsKeys(env: NodeJS.ProcessEnv = process.env): ApnsKeys | null {
  const keyId = env.APNS_KEY_ID?.trim(), teamId = env.APNS_TEAM_ID?.trim(), p8 = env.APNS_KEY_P8?.replace(/\\n/g, "\n").trim();
  if (!keyId || !teamId || !p8 || !/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId) || !p8.includes("PRIVATE KEY")) return null;
  return { keyId, teamId, p8, bundleId: env.APNS_BUNDLE_ID?.trim() || "vip.disciple.app" };
}

const b64u = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let jwtCache: { at: number; kid: string; jwt: string } | null = null;
/** Provider token; Apple wants it refreshed at most every 20-60 minutes. */
export function apnsJwt(k: ApnsKeys, now = Date.now()): string {
  if (jwtCache && jwtCache.kid === k.keyId && now - jwtCache.at < 40 * 60_000) return jwtCache.jwt;
  const head = b64u(Buffer.from(JSON.stringify({ alg: "ES256", kid: k.keyId })));
  const body = b64u(Buffer.from(JSON.stringify({ iss: k.teamId, iat: Math.floor(now / 1000) })));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(k.p8), dsaEncoding: "ieee-p1363" });
  const jwt = `${head}.${body}.${b64u(sig)}`;
  jwtCache = { at: now, kid: k.keyId, jwt };
  return jwt;
}

/** The alert body Apple receives. The icon badge shows 1 until the app is opened (mobile SceneDelegate clears it). `url` is the in-site path the app opens on tap (lib/native installNativeShell). */
export function apnsPayload(msg: { title: string; body: string; url: string; id?: string }): string {
  return JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: "default", badge: 1 }, url: msg.url, id: msg.id });
}

const HOST: Record<ApnsEnv, string> = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };

/** "gone": the token is no longer valid for this app (drop it). */
export async function sendApns(token: string, env: ApnsEnv, msg: { title: string; body: string; url: string; id?: string }, k: ApnsKeys): Promise<"ok" | "gone" | "error"> {
  if (!validApnsToken(token)) return "gone";
  let client: ClientHttp2Session | null = null;
  try {
    client = connect(HOST[env]);
    const c = client;
    return await new Promise<"ok" | "gone" | "error">((resolve) => {
      const t = setTimeout(() => resolve("error"), 6000);
      c.on("error", () => { clearTimeout(t); resolve("error"); });
      const req = c.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${apnsJwt(k)}`,
        "apns-topic": k.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400),
        "content-type": "application/json",
      });
      let status = 0, data = "";
      req.on("response", (h) => { status = Number(h[constants.HTTP2_HEADER_STATUS]) || 0; });
      req.on("data", (d: Buffer) => { data += d.toString(); });
      req.on("end", () => {
        clearTimeout(t);
        if (status === 200) return resolve("ok");
        // 410 Unregistered, 400 BadDeviceToken / DeviceTokenNotForTopic: the token is dead for this app
        if (status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(data))) return resolve("gone");
        resolve("error");
      });
      req.on("error", () => { clearTimeout(t); resolve("error"); });
      req.end(apnsPayload(msg));
    });
  } catch { return "error"; } finally { try { client?.close(); } catch { /* ignore */ } }
}

/**
 * Live Activity update (ActivityKit push, maker 2026-11-14): the token is the activity's own push token (not the device token),
 * the topic is "<bundle>.push-type.liveactivity". `state` must match the app's FlightAttributes.ContentState
 * (mobile/ios/App/Shared/FlightActivity.swift); updatedAt is seconds since 2001 (Swift Date's default Codable form).
 */
export async function sendLiveActivity(token: string, env: ApnsEnv, body: { event: "update" | "end"; state: Record<string, unknown>; staleSec?: number; dismissSec?: number }, k: ApnsKeys): Promise<"ok" | "gone" | "error"> {
  if (!validApnsToken(token)) return "gone";
  const now = Math.floor(Date.now() / 1000);
  const aps: Record<string, unknown> = { timestamp: now, event: body.event, "content-state": { ...body.state, updatedAt: now - 978_307_200 } };
  if (body.staleSec) aps["stale-date"] = now + body.staleSec;
  if (body.event === "end") aps["dismissal-date"] = now + (body.dismissSec ?? 300);
  let client: ClientHttp2Session | null = null;
  try {
    client = connect(HOST[env]);
    const c = client;
    return await new Promise<"ok" | "gone" | "error">((resolve) => {
      const t = setTimeout(() => resolve("error"), 6000);
      c.on("error", () => { clearTimeout(t); resolve("error"); });
      const req = c.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${apnsJwt(k)}`,
        "apns-topic": `${k.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-priority": "5",
        "content-type": "application/json",
      });
      let status = 0, data = "";
      req.on("response", (h) => { status = Number(h[constants.HTTP2_HEADER_STATUS]) || 0; });
      req.on("data", (d: Buffer) => { data += d.toString(); });
      req.on("end", () => {
        clearTimeout(t);
        if (status === 200) return resolve("ok");
        if (status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(data))) return resolve("gone");
        resolve("error");
      });
      req.on("error", () => { clearTimeout(t); resolve("error"); });
      req.end(JSON.stringify({ aps }));
    });
  } catch { return "error"; } finally { try { client?.close(); } catch { /* ignore */ } }
}

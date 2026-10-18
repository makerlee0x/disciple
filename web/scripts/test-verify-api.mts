// Verified-badge review API (lib/server/verification + lib/server/privyAuth).  pnpm test:verify-api
// Privy access tokens are minted locally with a throwaway ES256 key; the Privy users API is a stub fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "crypto";
import { adminAction, adminList, adminNonce, creatorNonce, submitRequest, verifiedMap, normWebsite, normX, type Deps, type VerifyStore } from "../lib/server/verification";
import { parseAdminEmails, verifyAccessToken, type FetchLike } from "../lib/server/privyAuth";

const APP = "cmapp0000000000test";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function jwt(claims: Record<string, unknown>, key = privateKey, alg = "ES256") {
  const h = b64u(JSON.stringify({ alg, typ: "JWT" })), p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }))}`;
}
const now = () => 1_800_000_000_000;
const tok = (sub: string, extra: Record<string, unknown> = {}) => jwt({ iss: "privy.io", aud: APP, sub, sid: "s", iat: now() / 1000 - 10, exp: now() / 1000 + 3600, ...extra });

const ADMIN = "did:privy:admin0001", CREATOR = "did:privy:creator01", RANDO = "did:privy:rando0001";
const ROCKET = "0x00000000000000000000000000000000000000aa", CREATOR_EOA = "0x00000000000000000000000000000000000000c1", CREATOR_SA = "0x00000000000000000000000000000000000000c2";
const users: Record<string, unknown> = {
  [ADMIN]: { id: ADMIN, linked_accounts: [{ type: "google_oauth", email: "Maker@Example.com" }] },
  [CREATOR]: { id: CREATOR, linked_accounts: [{ type: "email", address: "c@x.io" }, { type: "wallet", chain_type: "ethereum", address: CREATOR_EOA }] },
  [RANDO]: { id: RANDO, linked_accounts: [{ type: "email", address: "r@x.io" }, { type: "wallet", chain_type: "ethereum", address: "0x00000000000000000000000000000000000000d1" }] },
};
const calls: string[] = [];
const fakeFetch: FetchLike = async (url, init) => {
  calls.push(url);
  assert.ok(url.startsWith("https://api.privy.io/v1/users/"), "only the fixed Privy host is ever fetched");
  assert.equal(init?.headers?.["privy-app-id"], APP);
  const did = decodeURIComponent(url.split("/").pop()!);
  return { ok: !!users[did], status: users[did] ? 200 : 404, json: async () => users[did] };
};

function memStore(): VerifyStore {
  const m = new Map<string, string>(), s = new Map<string, Set<string>>();
  return {
    async setNX(k, v) { if (m.has(k)) return false; m.set(k, v); return true; },
    async get(k) { return m.get(k) ?? null; },
    async getDel(k) { const v = m.get(k) ?? null; m.delete(k); return v; },
    async del(...ks) { ks.forEach((k) => m.delete(k)); },
    async set(k, v) { m.set(k, v); },
    async mget(ks) { return ks.map((k) => m.get(k) ?? null); },
    async sadd(k, ...xs) { const x = s.get(k) ?? new Set(); xs.forEach((v) => x.add(v)); s.set(k, x); },
    async smembers(k) { return Array.from(s.get(k) ?? []); },
    async incrEx(k) { const n = Number(m.get(k) ?? 0) + 1; m.set(k, String(n)); return n; },
    async ttl() { return 60; },
  };
}
function deps(over: Partial<Deps> = {}): Deps {
  return {
    store: memStore(), privy: { appId: APP, appSecret: "secret", verificationKey: PEM }, adminEmails: "maker@example.com, ops@example.com",
    fetch: fakeFetch, now,
    creatorOf: async (t) => (t === ROCKET ? CREATOR_SA : null),
    accountsOf: async (u) => [...u.wallets, ...(u.wallets.includes(CREATOR_EOA) ? [CREATOR_SA] : [])],
    ...over,
  };
}
const nonceOf = async (d: Deps, who: string, admin = false) => {
  const [s, b] = admin ? await adminNonce(d, tok(who), "1.1.1.1") : await creatorNonce(d, tok(who), "1.1.1.1");
  assert.equal(s, 200); return b.nonce as string;
};

test("access token: signature, alg, iss, aud, exp, sub are all enforced", () => {
  const keys = [publicKey], t = Math.floor(now() / 1000);
  assert.equal(verifyAccessToken(tok(ADMIN), keys, APP, t)?.sub, ADMIN);
  assert.equal(verifyAccessToken(jwt({ iss: "privy.io", aud: APP, sub: ADMIN, exp: t + 60 }, other.privateKey), keys, APP, t), null, "foreign key");
  assert.equal(verifyAccessToken(tok(ADMIN, { iss: "evil.io" }), keys, APP, t), null);
  assert.equal(verifyAccessToken(tok(ADMIN, { aud: "otherapp000000" }), keys, APP, t), null);
  assert.equal(verifyAccessToken(tok(ADMIN, { exp: t - 3600 }), keys, APP, t), null, "expired");
  assert.equal(verifyAccessToken(tok("not-a-did"), keys, APP, t), null);
  const [h, p] = tok(ADMIN).split(".");
  assert.equal(verifyAccessToken(`${b64u(JSON.stringify({ alg: "none" }))}.${p}.`, keys, APP, t), null, "alg none");
  assert.equal(verifyAccessToken(`${h}.${b64u(JSON.stringify({ iss: "privy.io", aud: APP, sub: RANDO, exp: t + 60 }))}.${tok(ADMIN).split(".")[2]}`, keys, APP, t), null, "tampered payload");
});

test("ADMIN_EMAILS unset or blank ⇒ admin endpoints fail closed (503) even for a valid session", async () => {
  for (const v of [undefined, "", "  ,  ", "not-an-email"]) {
    assert.equal(parseAdminEmails(v), null);
    const d = deps({ adminEmails: v });
    assert.equal((await adminNonce(d, tok(ADMIN), "1.1.1.1"))[0], 503);
    assert.equal((await adminList(d, tok(ADMIN), "all", "1.1.1.1"))[0], 503);
    assert.equal((await adminAction(d, tok(ADMIN), { token: ROCKET, action: "approve", nonce: "0".repeat(32) }, "1.1.1.1"))[0], 503);
  }
});

test("missing Privy verification key / secret ⇒ 503, never accepted", async () => {
  const d = deps({ privy: { appId: APP } });
  assert.equal((await adminList(d, tok(ADMIN), "all", "1.1.1.1"))[0], 503);
  const d2 = deps({ privy: { appId: APP, verificationKey: PEM } }); // no app secret ⇒ can't read emails
  assert.equal((await adminList(d2, tok(ADMIN), "all", "1.1.1.1"))[0], 503);
});

test("non-admin and anonymous are rejected", async () => {
  const d = deps();
  assert.equal((await adminList(d, null, "all", "1.1.1.1"))[0], 401);
  assert.equal((await adminList(d, "garbage", "all", "1.1.1.1"))[0], 401);
  assert.equal((await adminList(d, tok(RANDO), "all", "1.1.1.1"))[0], 403);
  assert.equal((await adminNonce(d, tok(CREATOR), "1.1.1.1"))[0], 403);
  assert.equal((await adminList(d, tok(ADMIN), "all", "1.1.1.1"))[0], 200, "case-insensitive email match");
});

test("creator request → admin approve → badge; nonce replay rejected; reject/revoke clear it", async () => {
  const d = deps();
  const n = await nonceOf(d, CREATOR);
  const body = { token: ROCKET, x: "@disciple_fun", website: "disciple.fun", note: "team rocket", nonce: n };
  assert.deepEqual((await submitRequest(d, tok(CREATOR), body, "1.1.1.1"))[1], { ok: true, status: "pending" });
  assert.equal((await submitRequest(d, tok(CREATOR), body, "1.1.1.1"))[0], 401, "request nonce replay");
  assert.deepEqual(await verifiedMap(d.store, [ROCKET]), {}, "pending ⇒ no badge");

  const [, list] = await adminList(d, tok(ADMIN), "pending", "1.1.1.1");
  const rows = list.rows as { token: string; x: string; website: string; privyId?: string }[];
  assert.equal(rows.length, 1); assert.equal(rows[0].x, "disciple_fun"); assert.equal(rows[0].website, "https://disciple.fun/");
  assert.equal(rows[0].privyId, undefined, "internal id not exposed");

  const an = await nonceOf(d, ADMIN, true);
  assert.equal((await adminAction(d, tok(ADMIN), { token: ROCKET, action: "approve", nonce: an }, "1.1.1.1"))[0], 200);
  assert.equal((await adminAction(d, tok(ADMIN), { token: ROCKET, action: "approve", nonce: an }, "1.1.1.1"))[0], 401, "admin nonce replay");
  assert.deepEqual(await verifiedMap(d.store, [ROCKET.toUpperCase().replace("0X", "0x"), "sample-halo"]), { [ROCKET]: true });
  // an admin's nonce can't be used by anyone else
  const an2 = await nonceOf(d, ADMIN, true);
  assert.equal((await adminAction(d, tok(RANDO), { token: ROCKET, action: "revoke", nonce: an2 }, "1.1.1.1"))[0], 403);
  assert.equal((await adminAction(d, tok(ADMIN), { token: ROCKET, action: "revoke", nonce: an2 }, "1.1.1.1"))[1].status, "revoked");
  assert.deepEqual(await verifiedMap(d.store, [ROCKET]), {}, "revoked ⇒ badge off");
});

test("only the on-chain creator may request; bad inputs rejected; nonce bound to the user", async () => {
  const d = deps();
  const n = await nonceOf(d, RANDO);
  assert.equal((await submitRequest(d, tok(RANDO), { token: ROCKET, x: "rando", nonce: n }, "1.1.1.1"))[0], 403);
  const cn = await nonceOf(d, CREATOR);
  assert.equal((await submitRequest(d, tok(RANDO), { token: ROCKET, x: "rando", nonce: cn }, "1.1.1.1"))[0], 401, "someone else's nonce");
  assert.equal((await submitRequest(d, tok(CREATOR), { token: "0x00000000000000000000000000000000000000bb", x: "a", nonce: cn }, "1.1.1.1"))[0], 404);
  assert.equal((await submitRequest(d, tok(CREATOR), { token: ROCKET, nonce: cn }, "1.1.1.1"))[0], 400, "needs x or website");
  assert.equal(normX("https://x.com/disciple_fun/status/1"), "disciple_fun");
  assert.equal(normX("bad handle!"), false);
  for (const bad of ["http://127.0.0.1/", "http://localhost:3000", "javascript:alert(1)", "https://user:pw@a.com", "http://metadata.internal", "ftp://a.com"])
    assert.equal(normWebsite(bad), false, bad);
});

test("rate limits per IP on the request endpoint", async () => {
  const d = deps();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await creatorNonce(d, tok(CREATOR), "9.9.9.9"))[0];
  assert.equal(last, 429);
  assert.equal((await creatorNonce(d, tok(CREATOR), "8.8.8.8"))[0], 200);
});

test("ADMIN_EMAILS matches case-insensitively against Privy email / Google accounts", async () => {
  const { isAdminUser } = await import("../lib/server/privyAuth");
  const allow = parseAdminEmails(" MakerLeeTV@Gmail.com ");
  assert.ok(allow);
  assert.equal(isAdminUser({ id: "did:privy:x", emails: ["makerleetv@gmail.com"], wallets: [] }, allow), true);
  assert.equal(isAdminUser({ id: "did:privy:x", emails: ["someone@gmail.com"], wallets: [] }, allow), false);
  assert.equal(isAdminUser({ id: "did:privy:x", emails: ["makerleetv@gmail.com"], wallets: [] }, parseAdminEmails("")), false);
});

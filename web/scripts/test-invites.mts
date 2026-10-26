// Invite-only beta (lib/server/invites): code generation, redemption, single use, the 3-per-player limit, the switch,
// the route gates and the admin API.  pnpm test:invites
// Privy access tokens are minted locally with a throwaway ES256 key; the Privy users API is a stub fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "crypto";
import {
  ALPHABET, CODE_LEN, CODE_RE, K, PER_PLAYER, adminAction, adminList, adminNonce, admit, gateUser, gateWallet, mintCodes, myCodes,
  newCode, normCode, parseInviteEnv, playerAction, playerStatus, readMode, redeemCode, type Deps, type InviteStore,
} from "../lib/server/invites";
import type { FetchLike } from "../lib/server/privyAuth";

/* ---------------- fixtures ---------------- */
const tick = () => new Promise<void>((r) => setImmediate(r));
function memStore(): InviteStore & { m: Map<string, string> } {
  const m = new Map<string, string>(), s = new Map<string, Set<string>>(), z = new Map<string, Map<string, number>>();
  return {
    m,
    async setNX(k, v) { await tick(); if (m.has(k)) return false; m.set(k, v); return true; },
    async get(k) { await tick(); return m.get(k) ?? null; },
    async getDel(k) { await tick(); const v = m.get(k) ?? null; m.delete(k); return v; },
    async del(...ks) { await tick(); ks.forEach((k) => m.delete(k)); },
    async set(k, v) { await tick(); m.set(k, v); },
    async mget(ks) { await tick(); return ks.map((k) => m.get(k) ?? null); },
    async sadd(k, ...xs) { await tick(); const x = s.get(k) ?? new Set(); xs.forEach((v) => x.add(v)); s.set(k, x); },
    async smembers(k) { await tick(); return Array.from(s.get(k) ?? []); },
    async zadd(k, items) { await tick(); const x = z.get(k) ?? new Map(); items.forEach((i) => { if (!x.has(i.member)) x.set(i.member, i.score); }); z.set(k, x); },
    async zrange(k, limit = 1000, rev = false) { await tick(); return Array.from(z.get(k) ?? []).sort((a, b) => (rev ? b[1] - a[1] : a[1] - b[1])).slice(0, limit).map(([mm]) => mm); },
    async zrem(k, ...ms) { await tick(); const x = z.get(k); let n = 0; ms.forEach((mm) => { if (x?.delete(mm)) n++; }); return n; },
    async incrEx(k) { const n = Number(m.get(k) ?? 0) + 1; m.set(k, String(n)); return n; },
    async ttl() { return 60; },
  };
}

const APP = "cmapp0000000000test";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const nowMs = () => 1_800_000_000_000;
function tok(sub: string) {
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: "privy.io", aud: APP, sub, sid: "s", iat: nowMs() / 1000 - 10, exp: nowMs() / 1000 + 3600 }));
  return `${h}.${p}.${b64u(sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
}
const ADMIN = "did:privy:admin0001", ALICE = "did:privy:alice0001", BOB = "did:privy:bob000001", CAROL = "did:privy:carol0001", DAN = "did:privy:dan000001";
const ALICE_EOA = "0x00000000000000000000000000000000000000a1", ALICE_SA = "0x00000000000000000000000000000000000000a2";
const BOB_EOA = "0x00000000000000000000000000000000000000b1", BOB_SA = "0x00000000000000000000000000000000000000b2";
const users: Record<string, unknown> = {
  [ADMIN]: { id: ADMIN, linked_accounts: [{ type: "google_oauth", email: "MakerLeeTV@gmail.com" }] },
  [ALICE]: { id: ALICE, linked_accounts: [{ type: "email", address: "a@x.io" }, { type: "wallet", chain_type: "ethereum", address: ALICE_EOA }] },
  [BOB]: { id: BOB, linked_accounts: [{ type: "email", address: "b@x.io" }, { type: "wallet", chain_type: "ethereum", address: BOB_EOA }] },
  [CAROL]: { id: CAROL, linked_accounts: [{ type: "email", address: "c@x.io" }] },
  [DAN]: { id: DAN, linked_accounts: [{ type: "email", address: "d@x.io" }] },
};
const fakeFetch: FetchLike = async (url) => {
  const did = decodeURIComponent(url.split("/").pop()!);
  return { ok: !!users[did], status: users[did] ? 200 : 404, json: async () => users[did] };
};
const SA: Record<string, string> = { [ALICE_EOA]: ALICE_SA, [BOB_EOA]: BOB_SA };
function deps(over: Partial<Deps> = {}): Deps {
  return {
    store: memStore(), privy: { appId: APP, appSecret: "secret", verificationKey: PEM }, adminEmails: "makerleetv@gmail.com",
    envMode: "1", fetch: fakeFetch, now: nowMs,
    accountsOf: async (u) => [...u.wallets, ...u.wallets.map((w) => SA[w]).filter(Boolean)],
    ...over,
  };
}
const IP = "203.0.113.7";

/* ---------------- code generation ---------------- */
test("codes: 8 chars from A–Z and 2–9, never 0/O/1/I, and unique", () => {
  assert.equal(ALPHABET.length, 32);
  for (const bad of ["0", "O", "1", "I"]) assert.ok(!ALPHABET.includes(bad), bad);
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const c = newCode();
    assert.equal(c.length, CODE_LEN);
    assert.match(c, CODE_RE);
    assert.ok(!/[01OI]/.test(c));
    seen.add(c);
  }
  assert.equal(seen.size, 5000, "no collisions in 5000 codes");
  assert.equal(newCode(() => new Uint8Array(8).fill(255)), "99999999", "byte & 31 stays inside the alphabet");
});
test("normCode accepts lower case, spaces and dashes; rejects look-alikes and wrong lengths", () => {
  assert.equal(normCode(" abcd-2345 "), "ABCD2345");
  assert.equal(normCode("ABCD 2345"), "ABCD2345");
  assert.equal(normCode("ABCD0345"), null);
  assert.equal(normCode("ABCDO345"), null);
  assert.equal(normCode("ABC2345"), null);
  assert.equal(normCode(undefined), null);
});

/* ---------------- the switch ---------------- */
test("switch: OFF by default; INVITE_ONLY turns it on; the KV flag wins over the env", async () => {
  const s = memStore();
  assert.deepEqual(await readMode(s, undefined), { on: false, source: "default" });
  assert.deepEqual(await readMode(s, ""), { on: false, source: "default" });
  assert.deepEqual(await readMode(s, "maybe"), { on: false, source: "env" }, "a typo stays off");
  assert.deepEqual(await readMode(s, "0"), { on: false, source: "env" });
  for (const v of ["1", "true", "ON", "yes"]) assert.equal(parseInviteEnv(v), true, v);
  assert.deepEqual(await readMode(s, "1"), { on: true, source: "env" });
  await s.set(K.mode, "off");
  assert.deepEqual(await readMode(s, "1"), { on: false, source: "kv" });
  await s.set(K.mode, "on");
  assert.deepEqual(await readMode(s, undefined), { on: true, source: "kv" });
});
test("gates let everyone through while the switch is off", async () => {
  const s = memStore(), off = { on: false, source: "default" } as const, on = { on: true, source: "kv" } as const;
  assert.deepEqual(await gateUser(s, off, ALICE), { ok: true });
  assert.deepEqual(await gateWallet(s, off, ALICE_SA), { ok: true });
  assert.deepEqual(await gateUser(s, on, ALICE), { ok: false, reason: "invite_required" });
  assert.deepEqual(await gateWallet(s, on, ALICE_SA), { ok: false, reason: "invite_required" });
  assert.deepEqual(await gateWallet(s, on, "not-an-address"), { ok: false, reason: "invite_required" });
});

/* ---------------- redemption + single use ---------------- */
async function seededAlice(s: InviteStore) {
  await admit(s, ALICE, "admin", nowMs());
  return mintCodes(s, ALICE, nowMs());
}
test("redeem: lets the player in, links their wallets, and the gates open", async () => {
  const s = memStore(), on = { on: true, source: "kv" } as const;
  const [code] = await seededAlice(s);
  const r = await redeemCode(s, BOB, code.toLowerCase(), nowMs(), [BOB_EOA, BOB_SA]);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(await gateUser(s, on, BOB), { ok: true });
  assert.deepEqual(await gateWallet(s, on, BOB_SA), { ok: true });
  assert.deepEqual(await gateWallet(s, on, BOB_EOA.toUpperCase().replace("0X", "0x")), { ok: true }, "addresses are case-insensitive");
  assert.deepEqual(await myCodes(s, ALICE).then((cs) => cs.find((c) => c.code === code)), { code, used: true });
});
test("single use: a used code fails for the next player", async () => {
  const s = memStore();
  const [code] = await seededAlice(s);
  assert.deepEqual(await redeemCode(s, BOB, code, nowMs()), { ok: true });
  assert.deepEqual(await redeemCode(s, CAROL, code, nowMs()), { ok: false, error: "used" });
});
test("single use under a race: two players using one code at once ⇒ exactly one gets in", async () => {
  for (let i = 0; i < 20; i++) {
    const s = memStore();
    const [code] = await seededAlice(s);
    const rs = await Promise.all([redeemCode(s, BOB, code, nowMs()), redeemCode(s, CAROL, code, nowMs()), redeemCode(s, DAN, code, nowMs())]);
    assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  }
});
test("redeem refuses bad, unknown, own and second codes", async () => {
  const s = memStore();
  const [c1, c2] = await seededAlice(s);
  assert.deepEqual(await redeemCode(s, BOB, "nope", nowMs()), { ok: false, error: "bad_code" });
  assert.deepEqual(await redeemCode(s, BOB, "ZZZZZZZZ", nowMs()), { ok: false, error: "bad_code" });
  assert.deepEqual(await redeemCode(s, ALICE, c1, nowMs()), { ok: false, error: "already_in" });
  await s.del(K.user(ALICE));   // even a player who is somehow out can't use their own code
  assert.deepEqual(await redeemCode(s, ALICE, c1, nowMs()), { ok: false, error: "own_code" });
  assert.deepEqual(await redeemCode(s, BOB, c1, nowMs()), { ok: true });
  assert.deepEqual(await redeemCode(s, BOB, c2, nowMs()), { ok: false, error: "already_in" }, "one code per player; c2 stays unused");
  assert.equal((await myCodes(s, ALICE)).find((c) => c.code === c2)?.used, false);
});
test("one player using two codes at once burns only one", async () => {
  const s = memStore();
  const [c1, c2] = await seededAlice(s);
  const rs = await Promise.all([redeemCode(s, BOB, c1, nowMs()), redeemCode(s, BOB, c2, nowMs())]);
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  assert.equal((await myCodes(s, ALICE)).filter((c) => c.used).length, 1);
});

/* ---------------- per-player limit ---------------- */
test("limit: each player gets exactly 3 invites, minted once", async () => {
  const s = memStore();
  assert.equal(PER_PLAYER, 3);
  const codes = await seededAlice(s);
  assert.equal(codes.length, 3);
  assert.deepEqual(await mintCodes(s, ALICE, nowMs()), [], "no more after the first mint");
  assert.equal((await myCodes(s, ALICE)).length, 3);
  // the invited player gets their own 3, not more
  assert.deepEqual(await redeemCode(s, BOB, codes[0], nowMs()), { ok: true });
  assert.equal((await mintCodes(s, BOB, nowMs())).length, 3);
  assert.equal((await myCodes(s, BOB)).length, 3);
});
test("limit under a race: parallel status calls never mint more than 3", async () => {
  for (let i = 0; i < 20; i++) {
    const s = memStore();
    await admit(s, ALICE, "admin", nowMs());
    await Promise.all(Array.from({ length: 6 }, () => mintCodes(s, ALICE, nowMs())));
    assert.equal((await myCodes(s, ALICE)).length, 3);
  }
});
test("players who aren't in get no codes", async () => {
  const s = memStore();
  assert.deepEqual(await mintCodes(s, BOB, nowMs()), []);
  assert.deepEqual(await myCodes(s, BOB), []);
});

/* ---------------- player API ---------------- */
test("status: switch off ⇒ { mode: false } with no login needed", async () => {
  const d = deps({ envMode: undefined });
  assert.deepEqual(await playerStatus(d, null, IP), [200, { mode: false }]);
});
test("status + redeem + waitlist end to end (switch on)", async () => {
  const d = deps();
  assert.deepEqual(await playerStatus(d, null, IP), [200, { mode: true, signedIn: false }]);
  let [, st] = await playerStatus(d, tok(BOB), IP);
  assert.equal(st.in, false); assert.equal(st.left, 0);
  const [ws] = await playerAction(d, tok(BOB), { action: "waitlist" }, IP);
  assert.equal(ws, 200);
  [, st] = await playerStatus(d, tok(BOB), IP);
  assert.equal(st.waitlisted, true);
  // admin is let in automatically and sees 3 invites
  [, st] = await playerStatus(d, tok(ADMIN), IP);
  assert.equal(st.in, true); assert.equal(st.left, 3); assert.equal(st.admin, true);
  const code = (st.codes as { code: string }[])[0].code;
  const [rs, rb] = await playerAction(d, tok(BOB), { action: "redeem", code }, IP);
  assert.equal(rs, 200, JSON.stringify(rb));
  [, st] = await playerStatus(d, tok(BOB), IP);
  assert.equal(st.in, true); assert.equal(st.left, 3); assert.equal(st.waitlisted, false);
  assert.equal(await d.store.get(K.wallet(BOB_SA)), BOB, "smart account linked");
  const [us, ub] = await playerAction(d, tok(CAROL), { action: "redeem", code }, IP);
  assert.equal(us, 409); assert.equal(ub.error, "used");
  [, st] = await playerStatus(d, tok(ADMIN), IP);
  assert.equal(st.left, 2, "admin sees one invite used");
});

/* ---------------- admin API ---------------- */
test("admin: fails closed without ADMIN_EMAILS, refuses non-admins", async () => {
  const d = deps({ adminEmails: undefined });
  assert.equal((await adminList(d, tok(ADMIN), IP))[0], 503);
  assert.equal((await adminNonce(d, tok(ADMIN), IP))[0], 503);
  assert.equal((await adminList(deps(), tok(ALICE), IP))[0], 403);
  assert.equal((await adminList(deps(), null, IP))[0], 401);
});
test("admin: create, revoke, admit, top up, switch — each with a single-use nonce", async () => {
  const d = deps({ envMode: undefined });
  const nonce = async () => (await adminNonce(d, tok(ADMIN), IP))[1].nonce as string;
  const [cs, cb] = await adminAction(d, tok(ADMIN), { action: "create", n: 4, nonce: await nonce() }, IP);
  assert.equal(cs, 200); assert.equal((cb.codes as string[]).length, 4);
  const n1 = await nonce();
  assert.equal((await adminAction(d, tok(ADMIN), { action: "create", n: 1, nonce: n1 }, IP))[0], 200);
  assert.equal((await adminAction(d, tok(ADMIN), { action: "create", n: 1, nonce: n1 }, IP))[0], 401, "nonce is single use");
  assert.equal((await adminAction(d, tok(ADMIN), { action: "create", n: 999, nonce: await nonce() }, IP))[0], 400);
  const [a, b] = cb.codes as string[];
  // revoke an unused code ⇒ it can't be used
  assert.equal((await adminAction(d, tok(ADMIN), { action: "revoke", code: a, nonce: await nonce() }, IP))[0], 200);
  assert.deepEqual(await redeemCode(d.store, BOB, a, nowMs()), { ok: false, error: "bad_code" });
  // a used code can't be revoked
  assert.deepEqual(await redeemCode(d.store, BOB, b, nowMs()), { ok: true });
  assert.equal((await adminAction(d, tok(ADMIN), { action: "revoke", code: b, nonce: await nonce() }, IP))[0], 409);
  // admit from the waitlist, then top up
  await playerAction(d, tok(CAROL), { action: "waitlist" }, IP);
  let [, list] = await adminList(d, tok(ADMIN), IP);
  assert.deepEqual((list.waitlist as { privyId: string }[]).map((w) => w.privyId), [CAROL]);
  assert.equal((await adminAction(d, tok(ADMIN), { action: "admit", privyId: CAROL, nonce: await nonce() }, IP))[0], 200);
  [, list] = await adminList(d, tok(ADMIN), IP);
  assert.deepEqual(list.waitlist, [], "admitted players leave the waitlist");
  assert.equal((await mintCodes(d.store, CAROL, nowMs())).length, 3);
  assert.equal((await adminAction(d, tok(ADMIN), { action: "topup", privyId: CAROL, n: 2, nonce: await nonce() }, IP))[0], 200);
  assert.equal((await mintCodes(d.store, CAROL, nowMs())).length, 2);
  assert.equal((await myCodes(d.store, CAROL)).length, 5);
  assert.equal((await adminAction(d, tok(ADMIN), { action: "topup", privyId: DAN, n: 2, nonce: await nonce() }, IP))[0], 404);
  // switch: default off → on → default
  assert.equal(list.mode, false); assert.equal(list.modeSource, "default");
  await adminAction(d, tok(ADMIN), { action: "mode", mode: "on", nonce: await nonce() }, IP);
  assert.deepEqual(await readMode(d.store, d.envMode), { on: true, source: "kv" });
  await adminAction(d, tok(ADMIN), { action: "mode", mode: "default", nonce: await nonce() }, IP);
  assert.deepEqual(await readMode(d.store, d.envMode), { on: false, source: "default" });
  [, list] = await adminList(d, tok(ADMIN), IP);
  assert.ok((list.log as unknown[]).length >= 6, "every action is logged");
});

// Unit tests for single-use per-request nonces (W-3: username claims + chat login, lib/server/nonces).  pnpm test:nonces
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeNonce, issueNonce, isNonce, nonceValid, type NonceStore } from "../lib/server/nonces";
import { chatLoginMessage } from "../lib/chat/login";

function memStore(): NonceStore & { m: Map<string, { v: string; exp: number }>; now: number } {
  const m = new Map<string, { v: string; exp: number }>();
  const st = {
    m, now: 0,
    live(k: string) { const e = m.get(k); if (e && e.exp && e.exp <= st.now) { m.delete(k); return undefined; } return e; },
    async setNX(k: string, v: string, ttl = 0) { if (st.live(k)) return false; m.set(k, { v, exp: ttl ? st.now + ttl * 1000 : 0 }); return true; },
    async get(k: string) { return st.live(k)?.v ?? null; },
    async getDel(k: string) { const e = st.live(k); m.delete(k); return e?.v ?? null; },
    async del(...ks: string[]) { ks.forEach((k) => m.delete(k)); },
  };
  return st;
}
const A = "0xAaAa000000000000000000000000000000000001", B = "0xbbbb000000000000000000000000000000000002";

test("issuing never deletes or overwrites another pending nonce (the GET ?nonce=1 griefing bug)", async () => {
  const s = memStore();
  const victim = await issueNonce(s, "user:nonce", A, 600);
  for (let i = 0; i < 5; i++) await issueNonce(s, "user:nonce", A, 600);   // attacker spams GET for the victim's address
  assert.equal(await nonceValid(s, "user:nonce", victim, A), true);
  assert.equal(s.m.size, 6);
});
test("bound to the address, case-insensitive; malformed ids rejected without a store hit", async () => {
  const s = memStore(); const n = await issueNonce(s, "p", A, 600);
  assert.ok(isNonce(n));
  assert.equal(await nonceValid(s, "p", n, A.toLowerCase()), true);
  assert.equal(await nonceValid(s, "p", n, B), false);
  assert.equal(await consumeNonce(s, "p", n, B), false);
  for (const bad of ["", "x", null, undefined, 123, "../" + n, n.toUpperCase()]) assert.equal(await nonceValid(s, "p", bad, A), false);
});
test("single use: second consume fails (replay), and TTL expiry", async () => {
  const s = memStore(); const n = await issueNonce(s, "chat:nonce", A, 300);
  assert.equal(await consumeNonce(s, "chat:nonce", n, A), true);
  assert.equal(await consumeNonce(s, "chat:nonce", n, A), false);
  const m = await issueNonce(s, "chat:nonce", A, 300); s.now += 301_000;
  assert.equal(await consumeNonce(s, "chat:nonce", m, A), false);
});
test("valid check does not consume (username claim consumes only after a successful claim)", async () => {
  const s = memStore(); const n = await issueNonce(s, "user:nonce", A, 600);
  assert.equal(await nonceValid(s, "user:nonce", n, A), true);
  assert.equal(await nonceValid(s, "user:nonce", n, A), true);
  assert.equal(await consumeNonce(s, "user:nonce", n, A), true);
  assert.equal(await nonceValid(s, "user:nonce", n, A), false);
});
test("prefixes are separate namespaces (a username nonce can't log into chat)", async () => {
  const s = memStore(); const n = await issueNonce(s, "user:nonce", A, 600);
  assert.equal(await consumeNonce(s, "chat:nonce", n, A), false);
});
test("chat login message includes the nonce (a signature binds to one nonce)", () => {
  const m1 = chatLoginMessage(A, 1, "a".repeat(32)), m2 = chatLoginMessage(A, 1, "b".repeat(32));
  assert.notEqual(m1, m2); assert.match(m1, /Nonce: a{32}$/); assert.match(m1, new RegExp(A.toLowerCase()));
});

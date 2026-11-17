/** One pilot, several wallets (lib/server/xpAccount): XP / level / trophies / parts read the same from every login. */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.KV_LOCAL_FILE ||= `/tmp/disciple-kv-xpacct-${process.pid}.json`;
const rnd = () => "0x" + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const did = () => "did:privy:" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");

test("mergeLedgers: earned sources count once across wallets, spends count on each wallet", async () => {
  const { mergeLedgers, totals } = await import("../lib/server/xp");
  const row = (src: string, xp: number, ts: number, kind = "mission") => JSON.stringify({ src, kind, xp, label: src, ts });
  const a = [row("m:d1:x", 100, 1), row("a:first_boost", 200, 2), row("buy:flare", -50, 5, "buy")];
  const b = [row("m:d1:x", 100, 3), row("fp:d:7", 120, 4, "freeplay"), row("buy:flare", -50, 6, "buy")];
  const rows = mergeLedgers([a, b]);
  assert.deepEqual(rows.map((r) => r.ts), [1, 2, 4, 5, 6]);
  const t = totals(rows);
  assert.equal(t.total, 420);
  assert.equal(t.spendable, 320);
  // one wallet: unchanged behaviour (dedupe by src, order kept)
  assert.equal(mergeLedgers([[row("x", 5, 2), row("x", 5, 1)]]).length, 1);
});

test("email login on one device + Apple/Google on another: one account, XP and trophies match on both", async () => {
  const { kv } = await import("../lib/server/kv");
  const { linkAccount, accountWallets } = await import("../lib/server/xpAccount");
  const { award, xpSummary, ledgerOf } = await import("../lib/server/xp");
  const { ACH } = await import("../lib/server/achKeys");
  const { unlocksOf } = await import("../lib/server/achievements");
  const s = kv();
  const phone = rnd(), desktop = rnd(), email = `p${Date.now()}@example.com`;
  const now = Date.UTC(2026, 10, 17, 12);
  // the phone wallet earned XP and a trophy before any linking
  assert.ok(await award(phone, { src: "a:first_boost", kind: "milestone", xp: 400, label: "First boost", ts: now - 5000 }, s));
  assert.ok(await award(phone, { src: "fp:d:1", kind: "freeplay", xp: 120, label: "Daily", ts: now - 4000 }, s));
  await s.zadd(ACH.unlocks(phone), [{ score: now - 5000, member: JSON.stringify({ id: "first_boost", ts: now - 5000, tx: "0x", block: 1, logIndex: 0 }) }]);
  assert.ok(await award(desktop, { src: "fp:d:2", kind: "freeplay", xp: 60, label: "Daily", ts: now - 3000 }, s));
  assert.equal((await xpSummary(desktop, now, s)).totalXp, 60, "not linked yet: own wallet only");

  // phone signs in (Apple, shared email), then desktop (email OTP): two Privy users, same verified email
  const r1 = await linkAccount({ id: did(), emails: [email], wallets: [phone] }, s); assert.ok(r1.ok);
  const r2 = await linkAccount({ id: did(), emails: [email.toUpperCase()], wallets: [desktop] }, s); assert.ok(r2.ok && r2.joined.includes(desktop));
  assert.deepEqual((await accountWallets(desktop, s)).sort(), [desktop, phone].sort());

  const d = await xpSummary(desktop, now, s), p = await xpSummary(phone, now, s);
  assert.equal(d.totalXp, 580); assert.equal(p.totalXp, 580);
  assert.deepEqual(d.level, p.level);
  assert.deepEqual((await unlocksOf(desktop, s)).map((u) => u.id), ["first_boost"]);

  // a source already paid on the phone doesn't pay again on the desktop wallet
  assert.equal(await award(desktop, { src: "a:first_boost", kind: "milestone", xp: 400, label: "First boost", ts: now }, s), false);
  assert.equal((await ledgerOf(desktop, s)).reduce((a, r) => a + r.xp, 0), 580);
  // idempotent
  const r3 = await linkAccount({ id: did(), emails: [email], wallets: [desktop] }, s); assert.ok(r3.ok && r3.joined.length === 0);
});

test("free play daily cap and part purchases are per pilot, not per wallet", async () => {
  const { kv } = await import("../lib/server/kv");
  const { linkAccount } = await import("../lib/server/xpAccount");
  const { award, awardFreePlay, buyPart, ownedOf } = await import("../lib/server/xp");
  const { PARTS } = await import("../lib/parts");
  const s = kv(), a = rnd(), b = rnd(), user = did(), now = Date.UTC(2026, 10, 17, 15);
  await linkAccount({ id: user, emails: [], wallets: [a, b] }, s);
  const x = await awardFreePlay(a, "fp:p:1", 100, "p", now, s); assert.ok(x.ok && x.xp === 100);
  const y = await awardFreePlay(b, "fp:p:2", 100, "p", now + 1, s); assert.ok(y.ok && y.xp === 50 && y.capped);
  const part = PARTS.find((p) => p.cost > 0 && !p.minPrestige);
  if (!part) return;
  await award(a, { src: "gift", kind: "mission", xp: part.cost * 2, label: "gift", ts: now }, s);
  const bought = await buyPart(a, part.id, now + 2, s); assert.ok(bought.ok);
  assert.ok((await ownedOf(b, s)).includes(part.id));
  const twice = await buyPart(b, part.id, now + 3, s); assert.ok(!twice.ok);
});

test("unrelated players never merge", async () => {
  const { kv } = await import("../lib/server/kv");
  const { linkAccount, accountWallets } = await import("../lib/server/xpAccount");
  const s = kv(), a = rnd(), b = rnd();
  await linkAccount({ id: did(), emails: [`a${Date.now()}@x.io`], wallets: [a] }, s);
  await linkAccount({ id: did(), emails: [`b${Date.now()}@x.io`], wallets: [b] }, s);
  assert.deepEqual(await accountWallets(a, s), [a]);
  assert.deepEqual(await accountWallets(b, s), [b]);
});

test("one wallet per person: a later login with the same email is sent back to the first method", async () => {
  const { kv } = await import("../lib/server/kv");
  const { duplicateLogin } = await import("../lib/server/xpAccount");
  const { userFromLinkedAccounts } = await import("../lib/server/privyAuth");
  const s = kv(), email = `one${Date.now()}@gmail.com`, owns = async () => true;
  const first = userFromLinkedAccounts(did(), [{ type: "email", address: email, first_verified_at: 1_763_000_000 }, { type: "wallet", chain_type: "ethereum", address: rnd() }])!;
  assert.deepEqual(first.emailLogins, [{ email, method: "email", at: 1_763_000_000_000 }]);
  const google = userFromLinkedAccounts(did(), [{ type: "google_oauth", email: email.toUpperCase(), first_verified_at: 1_763_100_000 }])!;
  assert.equal(await duplicateLogin(first, owns, s), null);
  assert.equal(await duplicateLogin(first, owns, s), null, "the first login keeps working");
  assert.equal(await duplicateLogin(google, owns, s), "email");
  // the first account was deleted / its email moved (Privy login method transfer): the other login takes over
  assert.equal(await duplicateLogin(google, async () => false, s), null);
  assert.equal(await duplicateLogin(first, owns, s), null, "older login wins back");
  assert.equal(await duplicateLogin(google, owns, s), "email");
  // no email (X-only login): never blocked
  assert.equal(await duplicateLogin(userFromLinkedAccounts(did(), [{ type: "twitter_oauth", subject: "1", username: "x" }])!, owns, s), null);
});

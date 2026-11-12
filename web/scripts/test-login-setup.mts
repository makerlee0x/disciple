// Unit tests for lib/aa/loginSetup.ts (SITE #140, decision 3: one-tap set up at sign-in) and the session-only trade
// signer choice used by aaSend.   pnpm test:login-setup   (pure: no RPC, no DOM)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs, cachedHealth, createLoginSetup, isOneTapOff, onchainHealth, renewalDelayMs, setOneTapOff, storageLease, tradeSigner,
  SESSION_RENEW_AHEAD_MS, type LoginSetupDeps, type SessionHealth,
} from "../lib/aa/loginSetup";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const P13 = "0x3d3667e8880c6b633b424d645b8004788b1d6e27";   // policy 1.3.0 (on chain today)
const P14 = "0x1400000000000000000000000000000000000014";   // policy 1.4.0 (after the #106 redeploy)
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(o: { deployed?: boolean | undefined; health?: SessionHealth; off?: boolean; failInstall?: number; enabled?: boolean; slowInstall?: boolean } = {}) {
  let t = 1_000_000;
  const calls = { deployed: 0, health: 0, prepare: 0, install: [] as { deploy: boolean; why: string; health?: SessionHealth }[], warn: [] as string[] };
  let fails = o.failInstall ?? 0;
  let release: (() => void) | undefined;
  const state = { deployed: o.deployed, health: o.health ?? "missing" as SessionHealth };
  const deps: LoginSetupDeps = {
    now: () => t,
    enabled: () => o.enabled ?? true,
    oneTapOff: () => !!o.off,
    deployed: async () => { calls.deployed++; return state.deployed; },
    health: async () => { calls.health++; return state.health; },
    prepare: async () => { calls.prepare++; },
    install: async (_a, x) => {
      calls.install.push(x);
      if (o.slowInstall) await new Promise<void>((r) => { release = r; });
      if (fails > 0) { fails--; throw new Error("Your account is still getting ready. Try again in a moment."); }
      state.deployed = true; state.health = "live";
    },
    warn: (m) => { calls.warn.push(m); },
  };
  const setup = createLoginSetup(deps);
  return { setup, calls, state, adv: (ms: number) => { t += ms; }, release: () => release?.() };
}

test("new account: ONE owner op deploys + installs (gas top-up first); repeat sign-in is a no-op", async () => {
  const h = harness({ deployed: false });
  assert.equal(await h.setup.ensure(A, "login"), "deployed+installed");
  assert.deepEqual(h.calls.install, [{ deploy: true, why: "login", health: undefined }]);
  assert.equal(h.calls.prepare, 1, "drip awaited before the deploy op");
  assert.equal(h.calls.health, 0, "no session read for an undeployed account");
  h.adv(60_000);
  assert.equal(await h.setup.ensure(A, "login"), "ready");
  assert.equal(h.calls.install.length, 1);
});

test("dedupe: concurrent sign-in / remount / refocus share ONE run per account", async () => {
  const h = harness({ deployed: false, slowInstall: true });
  const p1 = h.setup.ensure(A, "login"), p2 = h.setup.ensure(A, "refocus"), p3 = h.setup.ensure(A.toLowerCase(), "login");
  await tick(); await tick();
  assert.equal(h.setup.busy(A), true);
  h.release();
  assert.deepEqual(await Promise.all([p1, p2, p3]), ["deployed+installed", "joined", "joined"]);
  assert.equal(h.calls.install.length, 1);
  assert.equal(h.calls.deployed, 1);
  assert.equal(h.setup.busy(A), false);
  assert.equal(await h.setup.ensure(A, "refocus"), "cooldown", "right after success: no re-check (a lagging read can't trigger a 2nd install)");
});

test("already deployed: live session ⇒ nothing; missing / expired / inactive ⇒ renew (no deploy)", async () => {
  for (const health of ["missing", "expired", "expiring", "inactive", "stale-policy"] as SessionHealth[]) {
    const h = harness({ deployed: true, health });
    assert.equal(await h.setup.ensure(A, "login"), "renewed", health);
    assert.deepEqual(h.calls.install, [{ deploy: false, why: "login", health }]);
    assert.equal(h.calls.prepare, 0, "no top-up wait for a renewal");
  }
  const live = harness({ deployed: true, health: "live" });
  assert.equal(await live.setup.ensure(A, "login"), "ready");
  assert.equal(live.calls.install.length, 0);
});

test("one-tap turned off by the player: never installs (deployed or not); disabled signer: skipped", async () => {
  const off = harness({ deployed: false, off: true });
  assert.equal(await off.setup.ensure(A, "login"), "one-tap-off");
  assert.equal(off.calls.deployed, 0); assert.equal(off.calls.install.length, 0);
  const off2 = harness({ deployed: true, health: "expired", off: true });
  assert.equal(await off2.setup.ensure(A, "refocus"), "one-tap-off");
  assert.equal(off2.calls.install.length, 0);
  const dis = harness({ enabled: false });
  assert.equal(await dis.setup.ensure(A, "login"), "disabled");
  assert.equal(await dis.setup.ensure(null, "login"), "unknown");
});

test("failure: never throws, backs off 5 s → 15 s → 45 s, then succeeds; urgent (trade tap) caps the wait at 5 s", async () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(backoffMs), [5_000, 15_000, 45_000, 135_000, 300_000]);
  const h = harness({ deployed: false, failInstall: 3 });
  assert.equal(await h.setup.ensure(A, "login"), "failed");
  assert.equal(h.calls.warn.length, 1); assert.match(h.calls.warn[0], /^\[disciple\] /);
  assert.equal(h.setup.lastError(A), "Your account is still getting ready. Try again in a moment.");
  assert.equal(await h.setup.ensure(A, "refocus"), "backoff");
  h.adv(5_001);
  assert.equal(await h.setup.ensure(A, "retry"), "failed");   // 2nd failure ⇒ 15 s
  h.adv(5_001);
  assert.equal(await h.setup.ensure(A, "refocus"), "backoff");
  assert.equal(await h.setup.ensure(A, "trade", { urgent: true }), "failed", "a refused tap retries after 5 s, not 15 s");
  h.adv(30_000);
  assert.equal(await h.setup.ensure(A, "refocus"), "backoff", "3rd failure ⇒ 45 s");
  h.adv(15_001);
  assert.equal(await h.setup.ensure(A, "retry"), "deployed+installed");
  assert.equal(h.setup.lastError(A), "");
  assert.equal(h.calls.install.length, 4);
});

test("chain status unreadable: no install, soft backoff, nothing shown to the player", async () => {
  const h = harness({ deployed: undefined });
  assert.equal(await h.setup.ensure(A, "login"), "failed");
  assert.equal(h.calls.install.length, 0);
  assert.equal(h.setup.lastError(A), "", "RPC hiccups never reach the wallet menu");
});

test("never rejects even if a dependency throws synchronously", async () => {
  const setup = createLoginSetup({ now: () => 0, enabled: () => { throw new Error("boom"); }, oneTapOff: () => false, deployed: async () => true, health: async () => "live", install: async () => {}, warn: () => {} });
  assert.equal(await setup.ensure(A, "login"), "failed");
});

test("cross-tab lease: a second tab defers while the first is setting up", async () => {
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  let now = 0;
  const a = storageLease(st, "tabA", () => now), b = storageLease(st, "tabB", () => now);
  assert.equal(a.acquire(A, 60_000), true);
  assert.equal(b.acquire(A, 60_000), false);
  now = 61_000; assert.equal(b.acquire(A, 60_000), true, "expired lease is taken over");
  b.release(A); assert.equal(a.acquire(A, 60_000), true);
  const h = harness({ deployed: false });
  const setup = createLoginSetup({ ...({} as LoginSetupDeps), now: () => 0, enabled: () => true, oneTapOff: () => false, deployed: async () => false, health: async () => "missing",
    install: async () => { h.calls.install.push({ deploy: true, why: "x" }); }, warn: () => {}, lease: { acquire: () => false, release: () => {} } });
  assert.equal(await setup.ensure(A, "login"), "other-tab");
  assert.equal(h.calls.install.length, 0);
});

test("one-tap off flag persists per account (survives reloads), case-insensitive", () => {
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(isOneTapOff(st, A), false);
  setOneTapOff(st, A, true);
  assert.equal(isOneTapOff(st, A.toLowerCase()), true);
  assert.equal(isOneTapOff(st, "0x" + "b".repeat(40)), false);
  setOneTapOff(st, A, false);
  assert.equal(isOneTapOff(st, A), false);
  assert.equal(isOneTapOff(undefined, A), false);
});

/* ---------- policy-address keyed renewal (FLOW: 1.3.0 → 1.4.0 redeploy) ---------- */
test("stale policy: a session cached / installed against 1.3.0 is stale once 1.4.0 is configured ⇒ reinstalled at sign-in", async () => {
  const now = 1_800_000_000_000, vu = now / 1000 + 86_400;
  const s13 = { account: A, validUntil: vu, policy: P13 };
  assert.equal(cachedHealth(s13, { account: A, policy: P13, nowMs: now }), "live");
  assert.equal(cachedHealth(s13, { account: A, policy: P14, nowMs: now }), "stale-policy", "same expiry, different policy address");
  assert.equal(cachedHealth({ ...s13, policy: undefined }, { account: A, policy: P13, nowMs: now }), "stale-policy", "pre-policy cache");
  assert.equal(cachedHealth({ ...s13, policy: P13.toUpperCase().replace("0X", "0x") }, { account: A, policy: P13, nowMs: now }), "live", "address case doesn't matter");
  // on-chain: sessionOf read from the CONFIGURED (1.4.0) policy finds nothing for the 1.3.0 entity ⇒ inactive; a hook
  // pointing at another module ⇒ stale-policy
  assert.equal(onchainHealth("live", { active: false }, { policy: P14, nowMs: now }), "inactive");
  assert.equal(onchainHealth("live", { active: true, hookPolicy: P13 }, { policy: P14, nowMs: now }), "stale-policy");
  assert.equal(onchainHealth("live", { active: true, validUntil: vu }, { policy: P14, nowMs: now }), "live");
  assert.equal(onchainHealth("live", undefined, { policy: P14, nowMs: now }), "live", "RPC hiccup: keep the cache");
  assert.equal(onchainHealth("stale-policy", { active: true }, { policy: P14, nowMs: now }), "stale-policy");
  // end to end through the coordinator: deployed account + stale-policy ⇒ renewed, once
  const h = harness({ deployed: true, health: cachedHealth(s13, { account: A, policy: P14, nowMs: now }) });
  assert.equal(await h.setup.ensure(A, "login"), "renewed");
  assert.deepEqual(h.calls.install, [{ deploy: false, why: "login", health: "stale-policy" }]);
});

test("expiry: expired (≤ 60 s left) and expiring (≤ 10 min) renew; FLOW's renewalDelayMs shape kept", () => {
  const now = 1_800_000_000_000;
  const at = (sec: number) => cachedHealth({ account: A, validUntil: now / 1000 + sec, policy: P13 }, { account: A, policy: P13, nowMs: now });
  assert.equal(at(30), "expired"); assert.equal(at(-5), "expired");
  assert.equal(at(300), "expiring"); assert.equal(at(3600), "live");
  assert.equal(cachedHealth({ account: "0x" + "c".repeat(40), validUntil: now / 1000 + 3600, policy: P13 }, { account: A, policy: P13, nowMs: now }), "missing", "other account");
  assert.equal(cachedHealth(null, { account: A, policy: P13 }), "missing");
  assert.equal(SESSION_RENEW_AHEAD_MS, 600_000);
  assert.equal(renewalDelayMs(now / 1000 + 3600, now), 3_000_000);
  assert.equal(renewalDelayMs(now / 1000 + 60, now), 5_000);
});

/* ---------- aaSend session-only branch (tradeSigner) ---------- */
test("trade signer: session when live + covered + headroom", () => {
  assert.deepEqual(tradeSigner({ trade: true, eligible: true, live: true, headroom: true, strictMode: true, deployed: true }), { as: "session" });
  assert.deepEqual(tradeSigner({ trade: false, eligible: true, live: true, headroom: true, strictMode: false, deployed: true }), { as: "session" });
});
test("trade signer: no live session ⇒ refuse (deployed, or a NEW account whose sign-in setup hasn't finished) — never owner-signed", () => {
  assert.equal(tradeSigner({ trade: true, eligible: true, live: false, headroom: false, strictMode: true, deployed: true }).as, "refuse");
  const fresh = tradeSigner({ trade: true, eligible: true, live: false, headroom: true, strictMode: true, deployed: false });
  assert.deepEqual(fresh, { as: "refuse", why: "account setup not finished" });
});
test("trade signer: owner kept for decision (4) — one-tap off, uncovered calls, own spend limit used up — and unknown status", () => {
  assert.equal(tradeSigner({ trade: true, eligible: true, live: false, headroom: true, strictMode: false, deployed: false }).as, "owner", "one-tap off / escape hatch");
  assert.equal(tradeSigner({ trade: true, eligible: false, live: true, headroom: true, strictMode: true, deployed: true }).as, "owner", "outside the session policy");
  assert.deepEqual(tradeSigner({ trade: true, eligible: true, live: true, headroom: false, strictMode: true, deployed: true }), { as: "owner", why: "spend limit used up" });
  assert.equal(tradeSigner({ trade: true, eligible: true, live: false, headroom: true, strictMode: true, deployed: undefined }).as, "owner", "RPC hiccup never blocks a trade");
  assert.equal(tradeSigner({ trade: false, eligible: true, live: false, headroom: true, strictMode: true, deployed: true }).as, "owner", "non-trades (withdraw, claims, installs) unaffected");
});

/**
 * One-tap setup at sign-in (SITE #140, lee's decision 3). Pure coordinator: no viem, no DOM — session.ts wires the
 * real reads / sends in, scripts/test-login-setup.mts drives it with fakes.
 *
 * On sign-in, in the background, never blocking or throwing into the UI:
 *  - account not deployed  ⇒ ONE owner-signed op deploys it AND installs the one-tap session (the existing
 *    enableOneTap → Mav2Account.sendCalls("owner") path: the op carries the factory while undeployed, same relay);
 *  - deployed, session missing / expired / about to expire / inactive / installed on another policy address
 *    (e.g. 1.3.0 after the 1.4.0 redeploy) ⇒ install a fresh session (renew);
 *  - deployed + session live on the configured policy ⇒ nothing.
 * Players who turned one-tap off are skipped (persisted per account, so it survives reloads).
 *
 * Dedupe: one setup in flight per account (module state, so React remounts / tab refocus join it), plus an optional
 * cross-tab lease (two tabs signing in at once don't both deploy). Failure ⇒ exponential backoff per account
 * (5 s, 15 s, 45 s … ≤ 5 min); success ⇒ a short cool-down so a lagging read right after doesn't trigger a second install.
 * Shape follows DISCIPLE FLOW's feat/trade-latency "session at deploy + renewal" (renewalDelayMs, SESSION_RENEW_AHEAD_MS)
 * so FLOW can drop its version.
 */
export type SessionHealth = "live" | "missing" | "expired" | "expiring" | "inactive" | "stale-policy";
export type CachedLike = { account: string; validUntil: number; policy?: string } | null | undefined;

/** Renew this long before validUntil (FLOW's SESSION_RENEW_AHEAD_MS). */
export const SESSION_RENEW_AHEAD_MS = 10 * 60_000;
/** ms until a background renewal of a session valid until `validUntilSec` (≥ 5 s) — FLOW's helper, same shape. */
export function renewalDelayMs(validUntilSec: number, nowMs = Date.now()): number {
  return Math.max(5_000, validUntilSec * 1000 - SESSION_RENEW_AHEAD_MS - nowMs);
}

/**
 * Health of a cached session key from the cache alone (no RPC). Keyed on the policy ADDRESS as well as expiry: a key
 * installed against another DiscipleSessionPolicy (1.3.0 → 1.4.0 redeploy) is "stale-policy" even if unexpired.
 */
export function cachedHealth(s: CachedLike, o: { account: string; policy: string; nowMs?: number; aheadMs?: number }): SessionHealth {
  if (!s || s.account.toLowerCase() !== o.account.toLowerCase()) return "missing";
  if (!s.policy || !o.policy || s.policy.toLowerCase() !== o.policy.toLowerCase()) return "stale-policy";
  const now = o.nowMs ?? Date.now(), left = s.validUntil * 1000 - now;
  if (left <= 60_000) return "expired";
  if (left <= (o.aheadMs ?? SESSION_RENEW_AHEAD_MS)) return "expiring";
  return "live";
}

/**
 * Health from the on-chain read: `onchain` = DiscipleSessionPolicy.sessionOf(account, entityId) read FROM THE CONFIGURED
 * policy address. A session installed on an older policy doesn't exist there ⇒ inactive. `hookPolicy`, when known
 * (the module the account's validation hook points at), must equal the configured address too.
 */
export function onchainHealth(cached: SessionHealth, onchain: { active: boolean; validUntil?: number; hookPolicy?: string } | undefined, o: { policy: string; nowMs?: number }): SessionHealth {
  if (cached !== "live" && cached !== "expiring") return cached;
  if (!onchain) return cached;   // RPC hiccup: trust the cache, the trade path re-checks
  if (onchain.hookPolicy && onchain.hookPolicy.toLowerCase() !== o.policy.toLowerCase()) return "stale-policy";
  if (!onchain.active) return "inactive";
  if (onchain.validUntil !== undefined && onchain.validUntil * 1000 <= (o.nowMs ?? Date.now()) + 60_000) return "expired";
  return cached;
}

/** Failure backoff: 5 s × 3^(n−1), ≤ 5 min. */
export function backoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(5 * 60_000, 5_000 * 3 ** (failures - 1));
}

export type SetupOutcome =
  | "disabled" | "one-tap-off" | "ready" | "deployed+installed" | "renewed" | "joined" | "backoff" | "other-tab" | "cooldown" | "unknown" | "failed";

export type LoginSetupDeps = {
  now(): number;
  /** One-tap globally available for this signer (policy configured, auto on, not a dev EOA owner, …). */
  enabled(): boolean;
  /** The player turned one-tap off for this account (persisted). */
  oneTapOff(account: string): boolean;
  /** true / false, or undefined when the chain can't tell right now (then: no action, retry with backoff). */
  deployed(account: string): Promise<boolean | undefined>;
  /** Session health for a DEPLOYED account (cache + on-chain sessionOf on the configured policy). */
  health(account: string): Promise<SessionHealth>;
  /** Before deploying (self-pay): make sure the first-op gas top-up has landed. Failures are ignored. */
  prepare?(account: string): Promise<unknown>;
  /** Install a session (deploy: the op also deploys the account). Must throw on failure. */
  install(account: string, o: { deploy: boolean; why: string; health?: SessionHealth }): Promise<unknown>;
  /** Cross-tab lease (localStorage); acquire → false when another tab holds it. */
  lease?: { acquire(account: string, ttlMs: number): boolean; release(account: string): void };
  warn(msg: string, detail?: Record<string, unknown>): void;
  /** Re-run later (after backoff / another tab's lease). Optional: tests leave it out. */
  schedule?(ms: number, run: () => void): void;
  onChange?(): void;
};

type Acct = { inflight?: Promise<SetupOutcome>; fails: number; retryAt: number; failedAt: number; okUntil: number; lastError: string };

export function createLoginSetup(d: LoginSetupDeps, o: { cooldownMs?: number; leaseMs?: number } = {}) {
  const cooldownMs = o.cooldownMs ?? 15_000, leaseMs = o.leaseMs ?? 60_000;
  const acc = new Map<string, Acct>();
  const get = (a: string) => { const k = a.toLowerCase(); let s = acc.get(k); if (!s) { s = { fails: 0, retryAt: 0, failedAt: 0, okUntil: 0, lastError: "" }; acc.set(k, s); } return s; };
  let retryTimer = false;
  const later = (a: string, ms: number) => {
    if (!d.schedule || retryTimer) return;
    retryTimer = true;
    d.schedule(ms, () => { retryTimer = false; void ensure(a, "retry"); });
  };

  async function run(a: string, why: string, s: Acct): Promise<SetupOutcome> {
    const deployed = await d.deployed(a);
    if (deployed === undefined) throw Object.assign(new Error("deployment status unknown"), { soft: true });
    let health: SessionHealth | undefined;
    if (deployed) {
      health = await d.health(a);
      if (health === "live") return "ready";
    }
    if (d.lease && !d.lease.acquire(a, leaseMs)) { later(a, Math.min(leaseMs, 10_000)); return "other-tab"; }
    try {
      if (!deployed) await d.prepare?.(a).catch(() => undefined);
      await d.install(a, { deploy: !deployed, why, health });
      s.fails = 0; s.retryAt = 0; s.lastError = ""; s.okUntil = d.now() + cooldownMs;
      return deployed ? "renewed" : "deployed+installed";
    } finally { d.lease?.release(a); }
  }

  /**
   * Idempotent; never rejects. Concurrent calls for the same account share one run. `urgent` (a refused trade tap):
   * the backoff wait is capped at the first step (5 s) so a player tapping again isn't stuck behind a long backoff.
   */
  function ensure(account: string | null | undefined, why: string, opt: { urgent?: boolean } = {}): Promise<SetupOutcome> {
    try {
      if (!account) return Promise.resolve("unknown");
      if (!d.enabled()) return Promise.resolve("disabled");
      if (d.oneTapOff(account)) return Promise.resolve("one-tap-off");
      const s = get(account);
      if (s.inflight) return s.inflight.then((r) => (r === "failed" ? r : "joined"));
      const now = d.now();
      if (now < s.okUntil) return Promise.resolve("cooldown");
      if (now < (opt.urgent ? Math.min(s.retryAt, s.failedAt + backoffMs(1)) : s.retryAt)) return Promise.resolve("backoff");
      const p = run(account, why, s).catch((e) => {
        s.fails++; s.failedAt = d.now(); s.retryAt = s.failedAt + backoffMs(s.fails);
        const msg = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160);
        if (!(e as { soft?: boolean })?.soft) s.lastError = msg;   // soft = couldn't read the chain: not shown anywhere
        d.warn("[disciple] one-tap setup at sign-in failed", { why, attempt: s.fails, retryInMs: backoffMs(s.fails), error: msg });
        later(account, backoffMs(s.fails));
        return "failed" as SetupOutcome;
      }).finally(() => { s.inflight = undefined; try { d.onChange?.(); } catch { /* */ } });
      s.inflight = p;
      try { d.onChange?.(); } catch { /* */ }
      return p;
    } catch (e) {
      try { d.warn("[disciple] one-tap setup at sign-in failed", { why, error: String((e as Error)?.message ?? e).slice(0, 160) }); } catch { /* */ }
      return Promise.resolve("failed");
    }
  }
  return {
    ensure,
    busy: (account?: string | null) => !!account && !!acc.get(account.toLowerCase())?.inflight,
    anyBusy: () => [...acc.values()].some((s) => !!s.inflight),
    lastError: (account?: string | null) => (account ? acc.get(account.toLowerCase())?.lastError ?? "" : ""),
    /** Forget backoff / cool-down (e.g. the player explicitly asked for one-tap again, or logout). */
    reset: (account?: string | null) => { if (account) acc.delete(account.toLowerCase()); else acc.clear(); },
  };
}
export type LoginSetup = ReturnType<typeof createLoginSetup>;

/* ---------- persisted "one-tap off" (player choice) ---------- */
export const ONE_TAP_OFF_LS = "disciple.oneTap.off.v1";
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined;
const offSet = (st: Store): Set<string> => { try { const v = JSON.parse(st?.getItem(ONE_TAP_OFF_LS) || "[]"); return new Set(Array.isArray(v) ? v.map(String) : []); } catch { return new Set(); } };
export function isOneTapOff(st: Store, account: string): boolean { return offSet(st).has(account.toLowerCase()); }
export function setOneTapOff(st: Store, account: string, off: boolean) {
  try { const s = offSet(st); if (off) s.add(account.toLowerCase()); else s.delete(account.toLowerCase()); st?.setItem(ONE_TAP_OFF_LS, JSON.stringify([...s])); } catch { /* private mode */ }
}

/* ---------- cross-tab lease (localStorage) ---------- */
export function storageLease(st: Store, tabId: string, now: () => number = Date.now) {
  const k = (a: string) => `disciple.oneTap.setupLease.v1.${a.toLowerCase()}`;
  return {
    acquire(a: string, ttlMs: number) {
      try {
        const cur = JSON.parse(st?.getItem(k(a)) || "null") as { tab: string; until: number } | null;
        if (cur && cur.tab !== tabId && cur.until > now()) return false;
        st?.setItem(k(a), JSON.stringify({ tab: tabId, until: now() + ttlMs }));
        return true;
      } catch { return true; }   // no storage: this tab's in-memory dedupe still holds
    },
    release(a: string) {
      try { const cur = JSON.parse(st?.getItem(k(a)) || "null") as { tab: string } | null; if (cur?.tab === tabId) (st as unknown as { removeItem?(k: string): void })?.removeItem?.(k(a)); } catch { /* */ }
    },
  };
}

/* ---------- aaSend's signer choice for trades (pure, so the session-only branch is unit-tested) ---------- */
export type TradeSignerInput = {
  trade: boolean; eligible: boolean; live: boolean; headroom: boolean;
  /** session-only mode applies: auto one-tap on, policy configured, Privy/local owner, player hasn't turned it off, no escape hatch */
  strictMode: boolean;
  /** account deployed (true/false) or unknown (RPC hiccup ⇒ never block the trade) */
  deployed: boolean | undefined;
  /**
   * Rapid-tap spec #9 (#144): the cap has room for this trade on its own but not on top of the session spend still in
   * flight (a cap race). Session-only mode refuses it before sending ("Spend limit reached") instead of a doomed send.
   */
  capRace?: boolean;
};
export type TradeSigner = { as: "session" } | { as: "owner"; why: string } | { as: "refuse"; why: string };
/**
 * Session key when the policy covers the calls, the session is live and has headroom. Otherwise, for trades in
 * session-only mode: refuse (and set up one-tap in the background) when the session isn't live — including a
 * brand-new account whose sign-in setup hasn't finished (decision 3: no owner-signed deploying trade). Owner stays for
 * (4): one-tap off (strictMode false), calls the session doesn't cover, a player-set spend limit that's used up, and
 * an unknown deployment status.
 */
export function tradeSigner(i: TradeSignerInput): TradeSigner {
  if (i.eligible && i.live && i.headroom) return { as: "session" };
  if (!i.trade) return { as: "owner", why: "not a trade" };
  if (!i.eligible) return { as: "owner", why: "outside session policy" };
  if (i.live && i.capRace && i.strictMode && i.deployed !== undefined) return { as: "refuse", why: "spend limit (trades in flight)" };
  if (i.live) return { as: "owner", why: "spend limit used up" };
  if (i.strictMode && i.deployed !== undefined) return { as: "refuse", why: i.deployed ? "no live session" : "account setup not finished" };
  return { as: "owner", why: i.strictMode ? "deployment status unknown" : "no live session (owner fallback allowed)" };
}

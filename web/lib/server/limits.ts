/**
 * Shared fixed-window rate limits (W-1/W-3). The counter lives in the shared Upstash store (lib/server/kv: INCR + EXPIRE
 * in one EVAL), so limits hold across Vercel lambdas; without KV env, kv() is the local in-memory store. If the store
 * errors at runtime, a per-process memory counter is used for that call (degraded, never unlimited).
 * Pure (no server-only): unit-tested by scripts/test-relay-policy.mts.
 */
export type CounterStore = { incrEx(k: string, ttlSec: number): Promise<number>; ttl(k: string): Promise<number>; get?(k: string): Promise<string | null> };
export type LimitResult = { ok: boolean; count: number; limit: number; retryAfterSec: number };

const mem = new Map<string, { n: number; exp: number }>();
export const memoryCounter: CounterStore = {
  async incrEx(k, ttl) {
    const now = Date.now(), e = mem.get(k);
    if (!e || e.exp <= now) { mem.set(k, { n: 1, exp: now + ttl * 1000 }); if (mem.size > 50_000) for (const [mk, v] of Array.from(mem)) if (v.exp <= now) mem.delete(mk); return 1; }
    return ++e.n;
  },
  async ttl(k) { const e = mem.get(k); return e ? Math.max(0, Math.ceil((e.exp - Date.now()) / 1000)) : -2; },
  async get(k) { const e = mem.get(k); return e && e.exp > Date.now() ? String(e.n) : null; },
};

export async function hitLimit(store: CounterStore, key: string, limit: number, windowSec: number): Promise<LimitResult> {
  let s = store, count: number;
  try { count = await s.incrEx(`rl:${key}`, windowSec); }
  catch { s = memoryCounter; count = await s.incrEx(`rl:${key}`, windowSec); }
  if (count <= limit) return { ok: true, count, limit, retryAfterSec: 0 };
  const t = await s.ttl(`rl:${key}`).catch(() => windowSec);
  return { ok: false, count, limit, retryAfterSec: t > 0 ? t : windowSec };
}

/** Client IP: Vercel sets x-real-ip / the first x-forwarded-for entry (it overwrites client-supplied values). */
export function clientIp(h: { get(name: string): string | null }): string {
  return (h.get("x-real-ip") || (h.get("x-forwarded-for") || "").split(",")[0] || "").trim().toLowerCase() || "unknown";
}

/** Limits for the self-bundler (/api/bundler). Rapid one-tap shots stay well under these. */
export const BUNDLER_LIMITS = {
  /** default 60/60 s; override with BUNDLER_SEND_PER_SENDER (see bundlerSendPerSender) — raising it is lee's call */
  sendPerSender: { limit: 60, windowSec: 60 },
  /**
   * AUDIT L1: retries of the SAME press (sender + pressId) that don't count toward sendPerSender — earned ONLY by a
   * server-side rejection of that press BEFORE anything was submitted (BUNDLER_PRESS_FREE_RETRIES).
   */
  pressFreeRetries: 2,
  /** AUDIT L1: cap on free-retry grants per sender per sendPerSender window (all presses together). */
  pressFreeGrantsPerSender: 10,
  sendPerIp: { limit: 120, windowSec: 60 },
  /** eth_estimateUserOperationGas + disciple_warm (RPC simulation / balance reads) */
  simPerIp: { limit: 120, windowSec: 60 },
} as const;

const posInt = (v: string | undefined, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : d; };
/** sendPerSender with the env override (BUNDLER_SEND_PER_SENDER, BUNDLER_PRESS_FREE_RETRIES; unset ⇒ the defaults above). */
export function bundlerSendPerSender(env: Record<string, string | undefined> = process.env) {
  const free = Number(env.BUNDLER_PRESS_FREE_RETRIES);
  return {
    limit: posInt(env.BUNDLER_SEND_PER_SENDER, BUNDLER_LIMITS.sendPerSender.limit),
    windowSec: BUNDLER_LIMITS.sendPerSender.windowSec,
    pressFreeRetries: Number.isInteger(free) && free >= 0 && free <= 10 ? free : BUNDLER_LIMITS.pressFreeRetries,
  };
}
export const PRESS_ID = /^[0-9a-f]{16,64}$/;
type PressLim = { limit: number; windowSec: number; pressFreeRetries: number };
const pressOk = (id: unknown): id is string => typeof id === "string" && PRESS_ID.test(id);
const grantKey = (sender: string, id: string) => `rl:bundler:press:grant:${sender}:${id}`;
const usedKey = (sender: string, id: string, i: number) => `rl:bundler:press:used:${sender}:${id}:${i}`;

/**
 * Rapid taps (spec item 10, server side) — AUDIT L1. Every send counts toward the per-sender limit EXCEPT a retry of a
 * press the server itself rejected BEFORE submitting anything (notePressRejected: simulation / validation / fee-floor
 * failure, no relayer tx signed). Each such rejection grants ONE free retry for that sender + pressId (at most
 * `pressFreeRetries` per press, `pressFreeGrantsPerSender` per sender per window). A press that reached submission
 * earns nothing, so a fresh client-chosen id buys nothing. No / malformed id, store errors ⇒ counted. The per-IP limit
 * always counts (checked separately by the route).
 */
export async function hitSenderSend(store: CounterStore, sender: string, pressId: unknown, lim: PressLim): Promise<LimitResult> {
  if (pressOk(pressId) && lim.pressFreeRetries > 0 && store.get) {
    try {
      const g = Math.min(Number(await store.get(grantKey(sender, pressId))) || 0, lim.pressFreeRetries);
      // grant i is consumed by the first send that claims its own counter (atomic INCR === 1): one free send per grant
      for (let i = 1; i <= g; i++) if ((await store.incrEx(usedKey(sender, pressId, i), lim.windowSec)) === 1) return { ok: true, count: 0, limit: lim.limit, retryAfterSec: 0 };
    } catch { /* unknown ⇒ counted */ }
  }
  return hitLimit(store, `bundler:send:sender:${sender}`, lim.limit, lim.windowSec);
}

/**
 * AUDIT L1: the relay failed this send BEFORE submitting anything — no relayer tx was signed (no txHash) and the
 * reason is a pre-flight simulation / validation / fee-floor / policy rejection. Anything that may have reached the
 * node (txHash known, timeouts, network, relayer not configured, unknown) is NOT a pre-send rejection.
 */
export function rejectedBeforeSend(e: unknown): boolean {
  const x = e as { txHash?: unknown; code?: unknown; message?: unknown } | undefined;
  if (!x || x.txHash || x.code === "relayer_not_configured") return false;
  if (x.code === "fee" || x.code === "gas" || x.code === "paymaster") return true;   // RelayPolicyError (lib/aa/gasPolicy)
  return /simulation failed|execution reverted|fee below relayer floor|above cap|\bAA[0-9]{2}\b/i.test(String(x.message ?? ""));
}

/**
 * AUDIT L1: record a pre-send rejection of sender + pressId ⇒ grants ONE free retry (bounded per press and per sender).
 * AUDIT Low (sender lockout): the rejected op may be anyone's (the sender is only CLAIMED — the op failed validation),
 * so the per-sender grant cap is keyed on caller IP + sender when `lim.ip` is given: an attacker spamming invalid ops for
 * a victim's sender only exhausts its own (ip, sender) grant budget, never the victim's. The grant itself stays keyed on
 * sender + pressId (a random per-press id), so the victim's retry is free from any IP.
 */
export async function notePressRejected(store: CounterStore, sender: string, pressId: unknown, lim: PressLim & { grantsPerSender?: number; ip?: string }): Promise<boolean> {
  if (!pressOk(pressId) || lim.pressFreeRetries <= 0) return false;
  try {
    const perSender = await store.incrEx(lim.ip ? `rl:bundler:press:grants:${lim.ip}:${sender}` : `rl:bundler:press:grants:${sender}`, lim.windowSec);
    if (perSender > (lim.grantsPerSender ?? BUNDLER_LIMITS.pressFreeGrantsPerSender)) return false;
    return (await store.incrEx(grantKey(sender, pressId), lim.windowSec)) <= lim.pressFreeRetries;
  } catch { return false; }
}

/**
 * AUDIT Low (pre-existing, sender lockout): the per-SENDER send limit used to be charged on the CLAIMED sender before
 * the op was validated, so one IP could post junk ops (bad signatures) naming a victim's sender, exhaust the victim's
 * sendPerSender bucket for its window and burn their free press retries. Now the send path is limited in two stages:
 *  1. pre-validation (route, before anything else): per IP (sendPerIp) + per IP+SENDER (`sendPerIpSender`, the
 *     paymaster L-3 pattern) — cheap spam stays bounded, and a third party only fills its OWN (ip, sender) bucket;
 *  2. post-validation (`beforeSend`, called by fastRelay / selfBundler after the gas/paymaster checks and the
 *     simulation — or the trusted fast-path decision — and BEFORE the relayer signs anything): the per-sender limit
 *     (hitSenderSend), which is also where a press's free retry is consumed.
 * The pre-validation (ip, sender) cap is the per-sender limit plus the per-window free-retry grant cap, so an honest
 * client that stays inside its post-validation budget (free retries included) can never hit it first.
 */
export class SendLimitError extends Error {
  readonly code = -32005;
  constructor(public retryAfterSec: number) { super(`rate limited, retry in ${retryAfterSec}s`); }
}
/**
 * AUDIT #145 Low A: ONLY our own pre-send limiter (beforeSend ⇒ SendLimitError, thrown before anything is signed) means
 * "nothing sent". A node / sequencer -32005 "rate limited" (e.g. on eth_sendRawTransaction, after the relayer signed) is
 * NOT ours: it must keep the unclear path (txHash / relayNonce, never notSent) so the client looks the op up instead of
 * retrying it (a retry uses a fresh nonce key ⇒ the trade could happen twice). A txHash on the error = signed ⇒ never ours.
 */
export const isSendLimitError = (e: unknown): e is SendLimitError =>
  e instanceof SendLimitError && (e as { txHash?: unknown }).txHash === undefined;
export function sendPerIpSender(lim: { limit: number; windowSec: number } = bundlerSendPerSender()) {
  return { limit: lim.limit + BUNDLER_LIMITS.pressFreeGrantsPerSender, windowSec: lim.windowSec };
}
export type SendLimiter = {
  /** stage 1, before validation: per IP + per IP+sender. null = allowed. */
  pre(): Promise<LimitResult | null>;
  /** stage 2, after validation, before signing: per sender (+ free press retry). Throws SendLimitError when over. */
  beforeSend(): Promise<void>;
  /** a send failed: a pre-send rejection grants the press ONE free retry (grant cap keyed on ip + sender). */
  rejected(e: unknown): Promise<void>;
  /** read-only: is the sender's (validated-sends) bucket already full? For forwards we can't hook before signing. */
  peek(): Promise<LimitResult | null>;
};
export function sendLimiter(store: CounterStore, o: { ip: string; sender: string; pressId?: unknown; env?: Record<string, string | undefined> }): SendLimiter {
  const lim = bundlerSendPerSender(o.env);
  const sender = o.sender.toLowerCase(), okSender = /^0x[0-9a-f]{40}$/.test(sender);
  let charged = false;
  return {
    async pre() {
      const ipSender = sendPerIpSender(lim);
      const checks = [hitLimit(store, `bundler:send:ip:${o.ip}`, BUNDLER_LIMITS.sendPerIp.limit, BUNDLER_LIMITS.sendPerIp.windowSec)];
      if (okSender) checks.push(hitLimit(store, `bundler:send:ipsender:${o.ip}:${sender}`, ipSender.limit, ipSender.windowSec));
      return (await Promise.all(checks)).find((r) => !r.ok) ?? null;
    },
    async beforeSend() {
      if (!okSender || charged) return;   // once per request (a nonce re-sign inside one send is not a new send)
      charged = true;
      const r = await hitSenderSend(store, sender, o.pressId, lim);
      if (!r.ok) throw new SendLimitError(r.retryAfterSec);
    },
    async peek() {
      if (!okSender || !store.get) return null;
      const k = `rl:bundler:send:sender:${sender}`;
      const n = Number(await store.get(k).catch(() => null)) || 0;
      if (n < lim.limit) return null;
      const t = await store.ttl(k).catch(() => lim.windowSec);
      return { ok: false, count: n, limit: lim.limit, retryAfterSec: t > 0 ? t : lim.windowSec };
    },
    async rejected(e) {
      if (okSender && !isSendLimitError(e) && rejectedBeforeSend(e)) await notePressRejected(store, sender, o.pressId, { ...lim, ip: o.ip }).catch(() => false);
    },
  };
}

/**
 * pm_getPaymasterAllowance limits (AUDIT #141 L-3). The endpoint is unauthenticated (an allowance is harmless to hand
 * out: sender-bound, every rule re-checked on-chain), so a per-SENDER bucket keyed on the sender alone let anyone
 * exhaust a victim's 30 / 10 min and push them onto the slower per-op path. The per-sender bucket is therefore keyed on
 * caller IP + sender: a third party only burns its own (ip, sender) bucket, and its total issuance stays bounded by the
 * shared per-IP limit. Same numbers as before for the real user (their client asks ~once per 8 min).
 */
export const ALLOWANCE_LIMITS = { perIpSender: { limit: 30, windowSec: 600 } } as const;
export function paymasterAllowanceLimits(ip: string, sender: string): [key: string, limit: number, windowSec: number][] {
  return [
    [`paymaster:ip:${ip}`, BUNDLER_LIMITS.simPerIp.limit, BUNDLER_LIMITS.simPerIp.windowSec],
    [`paymaster:allow:${ip}:${sender.toLowerCase()}`, ALLOWANCE_LIMITS.perIpSender.limit, ALLOWANCE_LIMITS.perIpSender.windowSec],
  ];
}

/**
 * Public GET endpoints that were missing per-IP caps (site security pass, 2026-10-28).
 *  - img: open image proxy (SSRF-safe, but still burns egress/CPU) — was unlimited after W-2
 *  - share card/pnl: PNG render + indexer catch-up
 *  - trades: indexer catch-up on every hit
 *  - username nonce: match profile/meta nonce (30/min) — was unmetered while meta was capped
 */
export const PUBLIC_GET_LIMITS = {
  imgPerIp: { limit: 60, windowSec: 60 },
  sharePerIp: { limit: 30, windowSec: 60 },
  tradesPerIp: { limit: 60, windowSec: 60 },
  usernameNoncePerIp: { limit: 30, windowSec: 60 },
  /** POST /api/image/resolve — up to 200 Upstash mgets per call */
  imageResolvePerIp: { limit: 30, windowSec: 60 },
  /** GET /api/home — cache miss runs indexer + RPC; CDN s-maxage helps but still cap */
  homePerIp: { limit: 60, windowSec: 60 },
  /** GET /api/chat/history + /api/chat/stream — store reads / long-lived SSE */
  chatReadPerIp: { limit: 60, windowSec: 60 },
  /** GET /api/profile/username lookup (?u= / ?resolve= / ?address=) */
  usernameLookupPerIp: { limit: 60, windowSec: 60 },
} as const;

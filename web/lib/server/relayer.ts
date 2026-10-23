import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/**
 * The relayer EOA (relayerKey(): RELAYER_PRIVATE_KEY; local dev/test may fall back to DRIP_FAUCET_KEY) signs the self-bundler's handleOps
 * (and, when they are the same key, /api/drip top-ups). Concurrent requests fetched
 * the same pending nonce ("Nonce provided for the transaction is lower than the current nonce of the account").
 * withRelayer() runs relayer sends one at a time per server instance and retries nonce errors (another instance /
 * a send outside this process may still race on serverless) with a fresh nonce.
 */
let tail: Promise<unknown> = Promise.resolve();

export const isNonceError = (e: unknown) =>
  /nonce (provided for the transaction is lower|too low|has already been used)|replacement transaction underpriced|already known/i
    .test(String((e as { details?: string })?.details || "") + " " + String((e as Error)?.message || e));

export function withRelayer<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  const attempt = async (left: number): Promise<T> => {
    try { return await fn(); }
    catch (e) { if (left > 0 && isNonceError(e)) { await new Promise((r) => setTimeout(r, 400)); return attempt(left - 1); } throw e; }
  };
  const run = tail.then(() => attempt(retries), () => attempt(retries));
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Relayer EOA key for the self-bundler (handleOps). W-1: a dedicated key, separate from the faucet, so a relay bug or
 * abuse can never drain the drip budget (and vice versa).
 *  - PRODUCTION (isProductionRelayer): FAIL CLOSED. RELAYER_PRIVATE_KEY must be set, valid, and derive to a different
 *    address than DRIP_FAUCET_KEY; otherwise relayerKey() throws RelayerNotConfiguredError and /api/bundler answers
 *    503 "relayer not configured". The faucet key is never used to sign bundles in production.
 *  - local only (next dev / tests / `vercel dev` / RELAYER_LOCAL_TEST=1): RELAYER_PRIVATE_KEY if set, else DRIP_FAUCET_KEY
 *    with a one-time warning. Vercel preview is NOT local: it fails closed like production.
 * Never logs key material.
 */
export class RelayerNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = "relayer_not_configured";
  constructor(detail?: string) { super(`relayer not configured${detail ? ` (${detail})` : ""}`); this.name = "RelayerNotConfiguredError"; }
}
export const isRelayerNotConfigured = (e: unknown): e is RelayerNotConfiguredError =>
  e instanceof RelayerNotConfiguredError || (e as { code?: string })?.code === "relayer_not_configured";

/**
 * "Production" for the relayer key = FAIL CLOSED (a dedicated RELAYER_PRIVATE_KEY, never the faucet key). AUDIT Lows:
 *  - Vercel: production AND preview fail closed (a preview deploy must not relay from DRIP_FAUCET_KEY); only
 *    VERCEL_ENV=development (`vercel dev`, local) keeps the fallback.
 *  - Self-hosted (no VERCEL): production unless the process is EXPLICITLY local: NODE_ENV=development|test (next dev,
 *    test runners) or RELAYER_LOCAL_TEST=1 (local `next start` e2e). NODE_ENV unset / anything else ⇒ production, so
 *    a self-hosted server can't silently keep the fallback by not setting NODE_ENV.
 *  - RELAYER_ENV=production asserts production everywhere (overrides RELAYER_LOCAL_TEST and NODE_ENV).
 */
export function isProductionRelayer(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RELAYER_ENV === "production") return true;
  if (env.VERCEL_ENV) return env.VERCEL_ENV !== "development";
  if (env.VERCEL) return true;                                       // on Vercel without VERCEL_ENV: fail closed
  if (env.RELAYER_LOCAL_TEST === "1") return false;
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

const addrOf = (k: string | undefined): string | undefined => {
  if (!k) return undefined;
  try { return privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex).address.toLowerCase(); } catch { return undefined; }
};

type Resolved = { key: Hex; fallback: boolean } | { error: string };
function resolveRelayer(env: NodeJS.ProcessEnv = process.env): Resolved {
  const k = env.RELAYER_PRIVATE_KEY, f = env.DRIP_FAUCET_KEY;
  if (isProductionRelayer(env)) {
    if (!k) return { error: "RELAYER_PRIVATE_KEY is not set" };
    const ra = addrOf(k);
    if (!ra) return { error: "RELAYER_PRIVATE_KEY is not a valid private key" };
    if (ra === addrOf(f)) return { error: "RELAYER_PRIVATE_KEY must not be the faucet key" };
    return { key: k as Hex, fallback: false };
  }
  if (k) return { key: k as Hex, fallback: false };
  if (f) return { key: f as Hex, fallback: true };
  return { error: "no RELAYER_PRIVATE_KEY or DRIP_FAUCET_KEY" };
}

let warnedFallback = false;
const loggedErrors = new Set<string>();
/** The relayer signing key. Throws RelayerNotConfiguredError (→ HTTP 503) when no usable key (see above). */
export function relayerKey(env: NodeJS.ProcessEnv = process.env): Hex {
  const r = resolveRelayer(env);
  if ("error" in r) {
    if (!loggedErrors.has(r.error)) {
      loggedErrors.add(r.error);
      console.error(`[relayer] relayer not configured: ${r.error}${isProductionRelayer(env) ? " (production: refusing to fall back to DRIP_FAUCET_KEY)" : ""}`);
    }
    throw new RelayerNotConfiguredError();
  }
  if (r.fallback && !warnedFallback) {
    warnedFallback = true;
    console.warn("[relayer] RELAYER_PRIVATE_KEY is not set: the self-bundler is relaying from DRIP_FAUCET_KEY (local dev/test only). Set a dedicated, funded RELAYER_PRIVATE_KEY.");
  }
  return r.key;
}
/**
 * true when the relayer and the faucet are the same EOA (they must then share one nonce cursor). Never true in
 * production (fail-closed: the faucet never relays); never throws.
 */
export function relayerIsFaucet(env: NodeJS.ProcessEnv = process.env): boolean {
  const r = resolveRelayer(env);
  if ("error" in r) return false;
  return r.fallback || addrOf(r.key) === addrOf(env.DRIP_FAUCET_KEY);
}

/**
 * The relayer EOA (relayerKey(): RELAYER_PRIVATE_KEY, falling back to DRIP_FAUCET_KEY) signs the self-bundler's handleOps
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
 * abuse can never drain the drip budget (and vice versa). RELAYER_PRIVATE_KEY if set; else falls back to
 * DRIP_FAUCET_KEY with a one-time warning so production keeps working until Maker funds a dedicated key.
 * Never logs key material.
 */
let warnedFallback = false;
export function relayerKey(): `0x${string}` | undefined {
  const k = process.env.RELAYER_PRIVATE_KEY;
  if (k) return k as `0x${string}`;
  const f = process.env.DRIP_FAUCET_KEY;
  if (f && !warnedFallback) {
    warnedFallback = true;
    console.warn("[relayer] RELAYER_PRIVATE_KEY is not set: the self-bundler is relaying from DRIP_FAUCET_KEY. Set a dedicated, funded RELAYER_PRIVATE_KEY.");
  }
  return f as `0x${string}` | undefined;
}
/** true when the relayer and the faucet are the same EOA (they must then share one nonce cursor). */
export const relayerIsFaucet = () => !process.env.RELAYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY.toLowerCase() === (process.env.DRIP_FAUCET_KEY || "").toLowerCase();

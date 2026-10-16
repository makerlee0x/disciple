/**
 * The DRIP_FAUCET_KEY EOA signs both /api/drip top-ups and the self-bundler's handleOps. Concurrent requests fetched
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

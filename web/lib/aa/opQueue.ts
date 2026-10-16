/**
 * Per-account UserOp serialization. A smart account has one EntryPoint nonce sequence (key 0): two sends that start
 * while an earlier op is still pending read the SAME nonce, so all but one fail (self-bundler: the relayer's
 * handleOps tx races too → "Nonce provided for the transaction is lower than the current nonce"). Rapid one-tap
 * shots therefore run strictly in order: each op starts after the previous one for that account settled (mined,
 * failed or timed out). A failure never blocks the queue.
 */
const tails = new Map<string, Promise<unknown>>();

export function serializeBy<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = key.toLowerCase();
  const prev = tails.get(k) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(k, tail);
  void tail.then(() => { if (tails.get(k) === tail) tails.delete(k); });
  return run;
}

/** Ops queued or running for this account (0 = idle). For UI hints / tests. */
export function queued(key: string): boolean { return tails.has(key.toLowerCase()); }

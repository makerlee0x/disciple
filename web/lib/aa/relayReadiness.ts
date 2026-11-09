/** Self relay is for INSTALLED sessions only; owner/login setup keeps the existing paid external path. */
export function installedRelaySession(op: { nonce: string; factory?: string; factoryData?: string }): boolean {
  try {
    const key = BigInt(op.nonce) >> 64n, entity = (key >> 8n) & 0xffffffffn;
    return (key & 255n) === 0n && entity > 0n && entity < 0x80000000n && !op.factory && (!op.factoryData || op.factoryData === "0x");
  } catch { return false; }
}
/** Background-only dedupe. Never caches success across logout, expiry or revocation. A job that hasn't settled after
 * `staleMs` (e.g. an owner signature that never returns) is no longer joined: the next trigger starts a fresh one. */
export function createRelayLoginJoin(o: { staleMs?: number; now?: () => number } = {}) {
  const staleMs = o.staleMs ?? 120_000, now = o.now ?? Date.now;
  const jobs = new Map<string, { job: Promise<void>; at: number }>();
  return (account: string, task: () => Promise<void>): Promise<void> => {
    const key = account.toLowerCase(), pending = jobs.get(key);
    if (pending && now() - pending.at < staleMs) return pending.job;
    const job = Promise.resolve().then(task).finally(() => { if (jobs.get(key)?.job === job) jobs.delete(key); });
    jobs.set(key, { job, at: now() }); return job;
  };
}

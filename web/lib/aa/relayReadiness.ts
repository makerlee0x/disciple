/** Self relay is for INSTALLED sessions only; owner/login setup keeps the existing paid external path. */
export function installedRelaySession(op: { nonce: string; factory?: string; factoryData?: string }): boolean {
  try {
    const key = BigInt(op.nonce) >> 64n, entity = (key >> 8n) & 0xffffffffn;
    return (key & 255n) === 0n && entity > 0n && entity < 0x80000000n && !op.factory && (!op.factoryData || op.factoryData === "0x");
  } catch { return false; }
}
/** Background-only dedupe. Never caches success across logout, expiry or revocation. */
export function createRelayLoginJoin() {
  const jobs = new Map<string, Promise<void>>();
  return (account: string, task: () => Promise<void>): Promise<void> => {
    const key = account.toLowerCase(), pending = jobs.get(key);
    if (pending) return pending;
    const job = Promise.resolve().then(task).finally(() => { jobs.delete(key); });
    jobs.set(key, job); return job;
  };
}

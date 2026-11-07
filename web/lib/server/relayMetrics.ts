/** Request-local, passive monotonic timing. Parallel spans overlap; never sum them as wall time.
 * enqueue/close are server stream handoff proxies, NOT TCP flush or browser TTFB. */
export class RelayMetrics {
  readonly startedAtUnixMs = Date.now();
  private start: number;
  private intervals: [number, number][] = [];
  private stages: Record<string, number> = Object.fromEntries(["parse", "authLogin", "sessionRead", "targetSelector", "rateLimitStore", "leaseAcquire", "simulate", "signTx", "syncSend", "mined", "leaseRelease", "reconciliation", "responseFlushEnqueue"].map(k => [k, 0]));
  constructor(private clock = () => performance.now()) { this.start = clock(); }
  elapsed() { return Math.round((this.clock() - this.start) * 100) / 100; }
  mark(name: string) { this.stages[name] = this.elapsed(); }
  async span<T>(name: string, task: () => Promise<T>): Promise<T> {
    const at = this.clock();
    try { return await task(); } finally { const end = this.clock(); this.intervals.push([at, end]); this.add(name, end - at); }
  }
  add(name: string, ms: number) { this.stages[name] = Math.round(((this.stages[name] ?? 0) + ms) * 100) / 100; }
  snapshot(): Record<string, number> {
    let covered = 0, end = this.start;
    for (const [a, b] of [...this.intervals].sort((a, b) => a[0] - b[0])) { covered += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    const elapsed = this.elapsed();
    return { ...this.stages, elapsed, unattributed: Math.max(0, Math.round((elapsed - covered) * 100) / 100) };
  }
}
/** Only immutable positive facts. Never cache LoginGate, sessions, nonces, balances or simulation. */
export class ImmutableRelayCache {
  private values = new Map<string, { until: number; value: Promise<unknown> }>();
  constructor(private ttlMs = 30_000, private clock = Date.now) {}
  clear() { this.values.clear(); }
  get<T>(key: string, read: () => Promise<T>, valid: (v: T) => boolean): Promise<T> {
    const hit = this.values.get(key);
    if (hit && hit.until > this.clock()) return hit.value as Promise<T>;
    const entry = { until: this.clock() + this.ttlMs, value: Promise.resolve().then(read) as Promise<unknown> };
    entry.value = entry.value.then(value => { if (!valid(value as T) && this.values.get(key) === entry) this.values.delete(key); return value; }, error => {
      if (this.values.get(key) === entry) this.values.delete(key); throw error;
    });
    this.values.set(key, entry);
    if (this.values.size > 256) this.values.delete(this.values.keys().next().value!);
    return entry.value as Promise<T>;
  }
}

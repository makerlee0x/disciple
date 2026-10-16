/** RPC hygiene: a token-bucket rate limiter, retry with exponential backoff, and adaptive getLogs range splitting. */

export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(private rps: number, private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
    this.tokens = rps;
  }
  async take() {
    if (!(this.rps > 0)) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rps) * 1000));
    }
  }
}

const msg = (e: any) => String(e?.details ?? e?.shortMessage ?? e?.message ?? e).toLowerCase();
export const isRangeError = (e: any) =>
  /range|too many|limit exceeded|response size|query returned more than|block range|10000 results|max results/.test(msg(e));
export const isRateLimit = (e: any) => /429|rate limit|too many requests|capacity/.test(msg(e)) || e?.status === 429;

export async function withRetry<T>(f: () => Promise<T>, opts: { retries?: number; baseMs?: number; limiter?: RateLimiter; sleep?: (ms: number) => Promise<void>; noRetry?: (e: any) => boolean } = {}): Promise<T> {
  const { retries = 6, baseMs = 250, limiter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), noRetry } = opts;
  for (let i = 0; ; i++) {
    await limiter?.take();
    try {
      return await f();
    } catch (e) {
      if (i >= retries || noRetry?.(e)) throw e;
      const wait = baseMs * 2 ** i * (isRateLimit(e) ? 4 : 1) + Math.random() * baseMs;
      await sleep(wait);
    }
  }
}

/**
 * getLogs over [from,to]; if the provider rejects the range (too many results / range too large), split it in half recursively
 * down to `minSpan` blocks. Returns logs in arbitrary chunk order (callers sort).
 */
export async function getLogsAdaptive<L>(
  fetch: (from: bigint, to: bigint) => Promise<L[]>,
  from: bigint, to: bigint, minSpan: bigint, retry: <T>(f: () => Promise<T>) => Promise<T>,
): Promise<L[]> {
  try {
    return await retry(() => fetch(from, to));
  } catch (e) {
    if (!isRangeError(e) || to - from + 1n <= minSpan) throw e;
    const mid = from + (to - from) / 2n;
    const a = await getLogsAdaptive(fetch, from, mid, minSpan, retry);
    const b = await getLogsAdaptive(fetch, mid + 1n, to, minSpan, retry);
    return a.concat(b);
  }
}

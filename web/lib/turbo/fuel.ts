/**
 * PRACTICE Turbo fuel store. Completely separate from game cash and from lib/wallet: its own localStorage key, its
 * own numbers, no chain. Falls back to memory when localStorage is missing (server, tests, private mode).
 */
export const TURBO_FUEL_KEY = "disciple.turbo.fuel.v1";

export interface FuelStore {
  get(): number;
  set(usd: number): void;
  subscribe(cb: (usd: number) => void): () => void;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function createFuelStore(opts: { key?: string; initialUsd?: number; storage?: Storage | null } = {}): FuelStore {
  const key = opts.key ?? TURBO_FUEL_KEY;
  let storage: Storage | null = null;
  if (opts.storage !== undefined) storage = opts.storage;
  else { try { storage = typeof window !== "undefined" ? window.localStorage : null; } catch { storage = null; } }
  let mem = opts.initialUsd ?? 0;
  const subs = new Set<(usd: number) => void>();

  const read = (): number => {
    if (!storage) return mem;
    try {
      const raw = storage.getItem(key);
      if (!raw) return opts.initialUsd ?? 0;
      const v = (JSON.parse(raw) as { usd?: unknown }).usd;
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    } catch { return mem; }
  };
  const store: FuelStore = {
    get: read,
    set(usd) {
      const v = round2(Math.max(0, Number.isFinite(usd) ? usd : 0));
      mem = v;
      if (storage) { try { storage.setItem(key, JSON.stringify({ v: 1, usd: v })); } catch { /* memory only */ } }
      subs.forEach((cb) => cb(v));
    },
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
  };
  // Other tabs.
  if (storage && typeof window !== "undefined") {
    window.addEventListener("storage", (e) => { if (e.key === key) { const v = read(); subs.forEach((cb) => cb(v)); } });
  }
  return store;
}

/**
 * Relayer key pool (feat/rapid-tap), OFF by default. RELAYER_KEY_POOL = comma-separated env-var NAMES (never keys),
 * e.g. "RELAYER_KEY_1,RELAYER_KEY_2". Each serverless instance leases ONE of those keys (KV SET NX + TTL at warm,
 * renewed off the hot path) and is then the only signer for that EOA ⇒ its local nonce cursor is authoritative and
 * instances don't collide on one relayer nonce. No lease available (pool exhausted, KV down) ⇒ the single
 * RELAYER_PRIVATE_KEY exactly as today. Unset / empty ⇒ disabled: identical to today.
 * Pure (store, env, clock and id injected) so it is unit-testable; logs names + addresses only, never key material.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/** The subset of lib/server/kv the lease needs. */
export interface LeaseStore {
  setNX(k: string, v: string, ttlSec: number): Promise<boolean>;
  /** Atomic: refresh the TTL only while the key still holds `v` (our lease). true if refreshed. */
  expireIfEq(k: string, v: string, ttlSec: number): Promise<boolean>;
}
export const LEASE_TTL_SEC = 60;
export const LEASE_RENEW_SEC = 20;
/** Stop signing with a lease this long before it would expire un-renewed (another instance may take it after). */
export const LEASE_SAFETY_SEC = 15;
export const leaseKey = (name: string) => `relayer:lease:${name}`;
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_POOL = 32;

/** RELAYER_KEY_POOL → env-var names (deduped, invalid names dropped). [] ⇒ pool disabled. */
export function poolNames(env: Record<string, string | undefined>): string[] {
  const raw = (env.RELAYER_KEY_POOL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = Array.from(new Set(raw.filter((n) => NAME.test(n) && n !== "DRIP_FAUCET_KEY"))).slice(0, MAX_POOL);
  if (ok.length !== raw.length) console.warn(`[relayer-pool] ignored ${raw.length - ok.length} invalid / duplicate / faucet name(s) in RELAYER_KEY_POOL`);
  return ok;
}
const addrOf = (k: string | undefined) => { try { return k ? privateKeyToAccount(k as Hex).address.toLowerCase() : undefined; } catch { return undefined; } };
/** The key behind `name`, or undefined when it is unset, malformed, or the faucet's key (the faucet never relays). */
export function poolKey(env: Record<string, string | undefined>, name: string): Hex | undefined {
  const v = env[name]?.trim();
  if (!v) return undefined;
  const k = (v.startsWith("0x") ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return undefined;
  const a = addrOf(k);
  if (!a || a === addrOf(env.DRIP_FAUCET_KEY)) return undefined;
  return k;
}
function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export type Lease = { name: string; key: Hex; address: string };
export class RelayerKeyPool {
  private lease?: Lease & { until: number; renewAt: number };
  private acquiring?: Promise<Lease | undefined>;
  private renewing?: Promise<void>;
  readonly stats = { acquired: 0, renewed: 0, lost: 0, exhausted: 0, errors: 0 };
  constructor(private o: {
    names: string[]; store: LeaseStore; id: string; resolve: (name: string) => Hex | undefined;
    now?: () => number; ttlSec?: number; renewSec?: number; safetySec?: number;
  }) {}
  private now() { return (this.o.now ?? Date.now)(); }
  private get ttl() { return this.o.ttlSec ?? LEASE_TTL_SEC; }
  /** The lease this instance may sign with right now (sync, no I/O), or undefined. */
  current(): Lease | undefined {
    const l = this.lease;
    if (!l) return undefined;
    if (this.now() >= l.until - (this.o.safetySec ?? LEASE_SAFETY_SEC) * 1000) return undefined;
    return { name: l.name, key: l.key, address: l.address };
  }
  /** current(), else acquire one (deduped). undefined ⇒ caller uses the single relayer key. */
  ensure(): Promise<Lease | undefined> {
    const c = this.current();
    if (c) return Promise.resolve(c);
    return (this.acquiring ??= this.acquire().finally(() => { this.acquiring = undefined; }));
  }
  /** Off the hot path: renew when due (never awaited by a send). A lost lease is dropped (next send re-acquires). */
  maybeRenew(): void {
    const l = this.lease;
    if (!l || this.now() < l.renewAt || this.renewing) return;
    this.renewing = this.o.store.expireIfEq(leaseKey(l.name), this.o.id, this.ttl).then((ok) => {
      if (this.lease !== l) return;
      if (ok) { l.until = this.now() + this.ttl * 1000; l.renewAt = this.now() + (this.o.renewSec ?? LEASE_RENEW_SEC) * 1000; this.stats.renewed++; }
      else { this.lease = undefined; this.stats.lost++; console.warn(`[relayer-pool] lease on ${l.name} (${l.address}) lost; re-acquiring`); }
    }, () => { this.stats.errors++; /* KV hiccup: keep signing until the local safety deadline, retry next call */ })
      .finally(() => { this.renewing = undefined; });
  }
  private async acquire(): Promise<Lease | undefined> {
    const names = this.o.names;
    if (!names.length) return undefined;
    const prev = this.lease?.name;
    const start = hashStr(this.o.id) % names.length;
    // our previous key first (re-take it if still ours), then a scan starting at a per-instance offset
    const order = [...(prev ? [prev] : []), ...names.slice(start), ...names.slice(0, start)].filter((n, i, a) => a.indexOf(n) === i);
    for (const name of order) {
      const key = this.o.resolve(name);
      if (!key) continue;
      try {
        const k = leaseKey(name);
        const got = (name === prev && await this.o.store.expireIfEq(k, this.o.id, this.ttl)) || await this.o.store.setNX(k, this.o.id, this.ttl);
        if (!got) continue;
        const address = privateKeyToAccount(key).address;
        const t = this.now();
        this.lease = { name, key, address, until: t + this.ttl * 1000, renewAt: t + (this.o.renewSec ?? LEASE_RENEW_SEC) * 1000 };
        this.stats.acquired++;
        if (name !== prev) console.info(`[relayer-pool] leased ${name} (${address})`);
        return { name, key, address };
      } catch { this.stats.errors++; return undefined; }   // KV down: the single key, no scan storm
    }
    this.lease = undefined; this.stats.exhausted++;
    console.warn(`[relayer-pool] no free key among ${names.length}; using the single relayer key`);
    return undefined;
  }
}

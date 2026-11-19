import "server-only";
/**
 * Anon balances for the anon launch pool (lib/anonPool). The pool holds everyone's USDG in one place on-chain; who owns
 * how much lives only here, keyed by Privy DID, so nothing on-chain ties a launch to a wallet.
 *
 * Every change runs under a short per-player lock (SET NX) so two tabs can't spend the same dollars. Amounts are raw
 * USDG units as decimal strings (Redis INCRBY is int64 and 18-dec test USDG overflows it).
 */
import { kv as defaultKv, type Kv } from "./kv";

const LOCK_TTL_SEC = 30;
const bal = (chainId: number, did: string) => `anonpool:bal:${chainId}:${did}`;
const lock = (chainId: number, did: string) => `anonpool:lock:${chainId}:${did}`;
const dep = (chainId: number, id: string) => `anonpool:dep:${chainId}:${id.toLowerCase()}`;

export class AnonBalanceError extends Error { notSent = true; }

export class AnonPoolLedger {
  constructor(private readonly chainId: number, private readonly store: () => Kv = defaultKv) {}

  async balance(did: string): Promise<bigint> {
    const v = await this.store().get(bal(this.chainId, did));
    return v && /^[0-9]+$/.test(v) ? BigInt(v) : BigInt(0);
  }

  private async withLock<T>(did: string, fn: (s: Kv) => Promise<T>): Promise<T> {
    const s = this.store();
    const token = `${Date.now()}:${Math.random()}`;
    if (!(await s.setNX(lock(this.chainId, did), token, LOCK_TTL_SEC))) throw new AnonBalanceError("another anon balance change is still running, try again");
    try { return await fn(s); }
    finally { await s.delIfEq(lock(this.chainId, did), token).catch(() => false); }
  }

  /** Add to a balance. */
  async credit(did: string, amount: bigint): Promise<bigint> {
    if (amount < BigInt(0)) throw new AnonBalanceError("bad amount");
    return this.withLock(did, async (s) => {
      const next = (await this.balance(did)) + amount;
      await s.set(bal(this.chainId, did), next.toString());
      return next;
    });
  }

  /** Take `amount` out, or throw when the balance is short. Returns the new balance. */
  async debit(did: string, amount: bigint): Promise<bigint> {
    if (amount < BigInt(0)) throw new AnonBalanceError("bad amount");
    if (amount === BigInt(0)) return this.balance(did);
    return this.withLock(did, async (s) => {
      const have = await this.balance(did);
      if (have < amount) throw new AnonBalanceError("not enough in your anon balance");
      const next = have - amount;
      await s.set(bal(this.chainId, did), next.toString());
      return next;
    });
  }

  /** Credit one on-chain deposit once. `id` = txHash:logIndex. false if it was already credited. */
  async creditDepositOnce(did: string, id: string, amount: bigint): Promise<boolean> {
    return this.withLock(did, async (s) => {
      if (!(await s.setNX(dep(this.chainId, id), did, 0))) return false;
      await s.set(bal(this.chainId, did), ((await this.balance(did)) + amount).toString());
      return true;
    });
  }
}

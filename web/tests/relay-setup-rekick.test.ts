// Item b (#259 follow-up): one-tap setup re-kicks on a same-owner remount and never stays joined to a dead run.
// Fakes only: no keys read, no signatures, no network sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginSetup, SETUP_STALE_MS, type LoginSetupDeps } from "../lib/aa/loginSetup";
import { createRelayLoginJoin } from "../lib/aa/relayReadiness";

const A = "0x00000000000000000000000000000000000000aa";
function harness(over: Partial<LoginSetupDeps> = {}) {
  let t = 1_000_000; const timers: { at: number; run: () => void }[] = []; const installs: { release: () => void; fail: (e: Error) => void }[] = [];
  const deps: LoginSetupDeps = {
    now: () => t, enabled: () => true, oneTapOff: () => false,
    deployed: async () => true, health: async () => "missing",
    install: () => new Promise((res, rej) => { installs.push({ release: () => res(undefined), fail: rej }); }),
    warn: () => undefined, schedule: (ms, run) => { timers.push({ at: t + ms, run }); }, ...over,
  };
  const ls = createLoginSetup(deps);
  const advance = async (ms: number) => { t += ms; for (const x of timers.splice(0).filter((x) => { if (x.at <= t) return true; timers.push(x); return false; })) x.run(); await flush(); };
  return { ls, installs, advance };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("login setup coordinator: stale in-flight run", () => {
  it("joins a healthy in-flight install (dedupe kept)", async () => {
    const h = harness();
    void h.ls.ensure(A, "login"); await flush();
    expect(await Promise.race([h.ls.ensure(A, "trade", { urgent: true }).then(() => "settled"), flush().then(() => "pending")])).toBe("pending");
    expect(h.installs.length).toBe(1); expect(h.ls.busy(A)).toBe(true);
    h.installs[0].release(); await flush(); expect(h.ls.busy(A)).toBe(false);
  });
  it("REGRESSION 11:55 CT: a hung install no longer pins 'getting ready'; the next trigger starts a fresh install", async () => {
    const h = harness({ schedule: undefined });   // no timers: the tap itself must re-kick
    void h.ls.ensure(A, "login"); await flush();
    expect(h.installs.length).toBe(1);
    await h.advance(SETUP_STALE_MS - 1); void h.ls.ensure(A, "trade", { urgent: true }); await flush();
    expect(h.installs.length).toBe(1);   // still joined before the deadline
    await h.advance(2);
    expect(h.ls.busy(A)).toBe(false);    // the dead run no longer reports "setting up"
    void h.ls.ensure(A, "trade", { urgent: true }); await flush();
    expect(h.installs.length).toBe(2); expect(h.ls.busy(A)).toBe(true);
    // the abandoned run failing late does not touch the new run's state
    h.installs[0].fail(new Error("late owner signature failure")); await flush();
    expect(h.ls.busy(A)).toBe(true); expect(h.ls.lastError(A)).toBe("");
    h.installs[1].release(); await flush();
    expect(h.ls.busy(A)).toBe(false); expect(h.ls.lastError(A)).toBe("");
  });
  it("re-kicks automatically at the deadline without any tap", async () => {
    const h = harness();
    void h.ls.ensure(A, "login"); await flush();
    await h.advance(SETUP_STALE_MS);
    expect(h.installs.length).toBe(2);
  });
  it("a settled run's timer never starts a second install", async () => {
    const h = harness();
    void h.ls.ensure(A, "login"); await flush(); h.installs[0].release(); await flush();
    await h.advance(SETUP_STALE_MS + 1);
    expect(h.installs.length).toBe(1);
  });
  it("a live session clears an old failure (another tab finished setup)", async () => {
    let health: "missing" | "live" = "missing";
    const h = harness({ health: async () => health, install: async () => { throw new Error("owner rejected"); } });
    await h.ls.ensure(A, "login"); expect(h.ls.lastError(A)).toMatch(/owner rejected/);
    health = "live"; await h.advance(60_000); await h.ls.ensure(A, "refocus");
    expect(h.ls.lastError(A)).toBe("");
  });
});

describe("relay LoginGate join (self-bundler path)", () => {
  it("joins a pending LoginGate job until its deadline, then starts a fresh one", async () => {
    let t = 0; const join = createRelayLoginJoin({ staleMs: 1000, now: () => t }); let n = 0;
    const hang = () => { n++; return new Promise<void>(() => undefined); };
    const a = join("0xAB", hang); expect(join("0xab", hang)).toBe(a); await flush(); expect(n).toBe(1);
    t = 1000; void join("0xab", hang); await flush(); expect(n).toBe(2);
  });
});

/* ---- session.ts wiring: same-owner remount (#259) and the self-bundler LoginGate step ---- */
const pve = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../lib/pve", async (orig) => ({ ...(await orig<object>()), ensurePveLoginOnchain: async (_pc: unknown, a: string) => { pve.calls.push(a); } }));
describe("session: same-owner wallet-ready re-checks setup", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SESSION_POLICY", "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2");
    vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_MODE", "self");
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); store.clear(); });
  it("remount with the same owner starts setup again (old code: zero attempts) and then runs the LoginGate step", async () => {
    vi.resetModules();
    const { Mav2Account } = await import("../lib/aa/mav2");
    const account = `0x${"22".repeat(20)}`;
    let installs = 0;
    vi.spyOn(Mav2Account.prototype, "address").mockResolvedValue(account as never);
    vi.spyOn(Mav2Account.prototype, "warmGasReserve").mockImplementation(async function (this: { deployed?: boolean }) { this.deployed = true; return undefined as never; });
    vi.spyOn(Mav2Account.prototype, "preparePrepay").mockResolvedValue({} as never);
    vi.spyOn(Mav2Account.prototype, "warm").mockResolvedValue(undefined);
    const session = await import("../lib/aa/session");
    const loginSetup = await import("../lib/aa/loginSetup");
    // first mount: another tab holds the lease ⇒ setup defers silently (the reported stuck state)
    store.set(`disciple.oneTap.setupLease.v1.${account}`, JSON.stringify({ tab: "other-tab", until: Date.now() + 60_000 }));
    const ensure = vi.fn();
    const owner = { address: "0x1111111111111111111111111111111111111111", type: "local" } as never;
    // count coordinator attempts through the lease (acquire is the first write after the health read)
    const realSet = store.set.bind(store);
    store.set = ((k: string, v: string) => { if (k.startsWith("disciple.oneTap.setupLease")) { installs++; ensure(); } return realSet(k, v); }) as typeof store.set;
    vi.spyOn(Mav2Account.prototype, "sendCalls").mockImplementation(() => new Promise(() => undefined) as never);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x01" }))) as never;
    await session.setPrivyOwner(owner); await flush(); await new Promise((r) => setTimeout(r, 20));
    expect(installs).toBe(0);
    expect(pve.calls).toContain(account);   // self mode: the LoginGate step still runs after a deferred setup
    store.delete(`disciple.oneTap.setupLease.v1.${account}`);
    await session.setPrivyOwner(owner); await new Promise((r) => setTimeout(r, 50));
    expect(installs).toBe(1);   // regression: the old same-owner early return left this at 0
    expect(loginSetup.SETUP_STALE_MS).toBeGreaterThan(30_000);
    await session.aaLogout();
  });
});

// Browser integration with fake storage, owner client and RPC only. No credential reads, signatures or broadcasts.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
process.env.NEXT_PUBLIC_RHT_PAYMASTER = "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136";
const { Mav2Account } = await import("../lib/aa/mav2");
const { deployment } = await import("../lib/chains");
const d = deployment(), account = `0x${"22".repeat(20)}` as Address;
const owner = privateKeyToAccount(`0x${"02".repeat(32)}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("restored signed-in deployed owner: silent lease exit is explained; same-owner readiness resumes ONE install", async (t) => {
  const leaseKey = `disciple.oneTap.setupLease.v1.${account.toLowerCase()}`;
  const store = new Map<string, string>([[leaseKey, JSON.stringify({ tab: "another-tab", until: Date.now() + 60_000 })]]);
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
  const session = await import("../lib/aa/session");
  const reports: Record<string, any>[] = [];
  let installed = 0, trades = 0, release: (() => void) | undefined;
  t.mock.method(console, "info", (_m, data) => { if (data?.outcome) reports.push(data); });
  t.mock.method(console, "warn", () => {});
  t.mock.method(Mav2Account.prototype, "address", async () => account);
  // The known allowance cache miss does NOT gate auto setup. Background warmup is intentionally unavailable.
  t.mock.method(Mav2Account.prototype, "warmGasReserve", async function (this: Mav2Account) { this.deployed = true; throw new Error("allowance unavailable"); });
  t.mock.method(Mav2Account.prototype, "preparePrepay", async () => ({}));
  t.mock.method(Mav2Account.prototype, "warm", async () => {});
  t.mock.method(Mav2Account.prototype, "useSession", async function (this: Mav2Account, entityId: number) {
    Object.assign(this, { sessionClient: { entityId, c: Promise.resolve({}) } });
  });
  t.mock.method(Mav2Account.prototype, "sendCalls", async (_calls, as) => {
    if (as !== "owner") { trades++; throw new Error("must never send a trade before setup"); }
    installed++;
    await new Promise<void>(resolve => { release = resolve; });
    return { txHash: `0x${"12".repeat(32)}`, userOpHash: `0x${"13".repeat(32)}`, gasMode: "usdg" };
  });
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const one = (r: { id: number; method: string; params: { data: string }[] }) => {
      assert.ok(["eth_call", "eth_getBlockByNumber", "eth_getCode"].includes(r.method), `no actual send allowed: ${r.method}`);
      let result: unknown;
      if (r.method === "eth_getCode") result = "0x01";
      else if (r.method === "eth_getBlockByNumber") result = { timestamp: `0x${Math.floor(Date.now()/1000).toString(16)}`, number: "0x1" };
      else {
        const sel = r.params[0].data.slice(0, 10);
        const fn = ["moduleId() view returns(string)", "paymaster() view returns(address)", "PREPAY_VERSION() view returns(uint256)",
          "creditOf(address) view returns(uint256)", "reservedOf(address) view returns(uint256)", "bootstrapUsed(address) view returns(bool)"].find(s => toFunctionSelector(s) === sel);
        assert.ok(fn, `unexpected read ${sel}`);
        const name = fn.slice(0, fn.indexOf("("));
        const value = name === "moduleId" ? "disciple.session-policy.1.4.3" : name === "paymaster" ? d.paymaster : name === "PREPAY_VERSION" ? 5n : name === "bootstrapUsed" ? false : 0n;
        result = encodeFunctionResult({ abi: parseAbi([`function ${fn}`]), functionName: name, result: value } as never);
      }
      return { jsonrpc: "2.0", id: r.id, result };
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  });
  try {
    await session.setPrivyOwner(owner);
    for (let i = 0; i < 50 && !reports.some(r => r.outcome === "other-tab"); i++) await tick();
    await tick();
    assert.deepEqual(session.oneTapStatus(), { on: false, settingUp: false, error: "", needsCash: false });
    assert.equal(installed, 0, "reproduces deployed + no session + no in-flight setup + no error");
    assert.ok(reports.some(r => r.outcome === "other-tab" && /lease/.test(r.reason) && r.retryInMs === 10_000));
    const abi = parseAbi(["function approve(address,uint256)", "function buyWithUsdg(address,uint256,uint256,uint256)"]);
    const calls = [{ to: d.usdg, data: encodeFunctionData({ abi, functionName: "approve", args: [d.router, 100_000n] }) },
      { to: d.router, data: encodeFunctionData({ abi, functionName: "buyWithUsdg", args: [account, 100_000n, 1n, BigInt(Math.floor(Date.now()/1000)+600)] }) }];
    const before = reports.length;
    await assert.rejects(session.aaSend(calls, {}, { trade: true }), (e: any) => e.extra?.sessionRequired === true);
    for (let i = 0; i < 50 && reports.length === before; i++) await tick();
    assert.ok(reports.slice(before).some(r => r.why === "trade" && r.outcome === "other-tab"), "refusal already DOES trigger the coordinator");
    assert.equal(trades, 0, "no owner fallback trade");
    store.delete(leaseKey);
    // No logout/login, account reset, or visibility event: reconnecting the SAME owner must re-check setup.
    await Promise.all([session.setPrivyOwner(owner), session.setPrivyOwner(owner)]);
    for (let i = 0; i < 100 && !release; i++) await tick();
    assert.equal(installed, 1, "regression: old same-owner early return would leave zero attempts");
    assert.equal(session.oneTapStatus().settingUp, true);
    assert.ok(reports.some(r => r.why === "wallet-ready" && r.outcome === "checking"));
    release!();
    for (let i = 0; i < 100 && !session.oneTapStatus().on; i++) await tick();
    assert.equal(session.oneTapStatus().on, true);
    assert.equal(installed, 1, "coordinator dedupe retained");
    assert.equal(trades, 0);
  } finally {
    release?.();
    await session.aaLogout();
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

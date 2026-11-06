// Browser session integration: reject -> renew even if sessionOf still says active.
// Entirely mocked; no RPC, credentials, or transactions.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
process.env.NEXT_PUBLIC_SESSION_POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2";
process.env.NEXT_PUBLIC_RHT_PAYMASTER = "0x5C3f7400ED41aCd7409D213caB2909e3b1E31136";
const { Mav2Account } = await import("../lib/aa/mav2");
const { AAError } = await import("../lib/aa/core");
const session = await import("../lib/aa/session");
const { deployment } = await import("../lib/chains");
const { policyAbi } = await import("@disciple/session-keys");
const d = deployment(), account = `0x${"11".repeat(20)}` as Address;
const key = `0x${"01".repeat(32)}` as const;
const zero = `0x${"00".repeat(20)}` as Address;
const cap = (1n << 128n) - 1n, validUntil = Math.floor(Date.now() / 1000) + 3600;
const oldSession = { account, policy: session.SESSION_POLICY, entityId: 7, key, validUntil, maxSlippageBps: 1500,
  caps: { [d.usdg.toLowerCase()]: cap.toString(), [d.defaultQuote.toLowerCase()]: cap.toString() }, spent: {} };
const liveRecord = { cfg: { validUntil, validAfter: 0, permissions: 639n, router: d.router, launchpad: d.launchpad,
  anonLauncher: "0x73a2a6e049aa21A5C440F3bc358dE37FE3f7C509", trampWallManager: d.trampWallManager,
  quote0: d.defaultQuote, quote1: d.usdg, cap0: cap, cap1: cap, maxSlippageBps: 1500, stealthOwner: zero }, spent0: 0n, spent1: 0n, active: true };
const delay = () => new Promise(resolve => setTimeout(resolve, 10));

test("AA24 with an active unexpired session triggers renewal, never an owner-signed trade or resend", async (t) => {
  const store = new Map<string, string>([["disciple.aa.sessionKey.v2", JSON.stringify(oldSession)]]);
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
  let installed = 0, trades = 0, cleared = 0;
  let failure = "simulation failed: AA24 signature error at https://rpc.invalid/private-token";
  let blockTrade = false, rejectTrade: ((e: Error) => void) | undefined;
  t.mock.method(Mav2Account.prototype, "address", async () => account);
  t.mock.method(Mav2Account.prototype, "warmGasReserve", async function (this: Mav2Account) { this.deployed = true; });
  t.mock.method(Mav2Account.prototype, "preparePrepay", async () => ({}));
  t.mock.method(Mav2Account.prototype, "warm", async () => {});
  t.mock.method(Mav2Account.prototype, "useSession", async function (this: Mav2Account, entityId: number) { Object.assign(this, { sessionClient: { entityId, c: Promise.resolve({}) } }); });
  t.mock.method(Mav2Account.prototype, "clearSession", function (this: Mav2Account) { cleared++; Object.assign(this, { sessionClient: undefined }); });
  t.mock.method(Mav2Account.prototype, "sendCalls", async (_calls, as) => {
    if (as === "session" || as?.as === "session") {
      trades++;
      if (blockTrade) return new Promise((_resolve, reject) => { rejectTrade = reject; });
      throw new AAError("Estimate", failure);
    }
    installed++; return { txHash: `0x${"12".repeat(32)}`, userOpHash: `0x${"13".repeat(32)}`, gasMode: "usdg" };
  });
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const one = (r: { id: number; method: string; params: { data: string }[] }) => {
      assert.ok(["eth_call", "eth_getBlockByNumber", "eth_getCode"].includes(r.method), `No real RPC/send: ${r.method}`);
      let result: unknown;
      if (r.method === "eth_getBlockByNumber") result = { timestamp: `0x${Math.floor(Date.now()/1000).toString(16)}`, number: "0x1" };
      else if (r.method === "eth_getCode") result = "0x01";
      else {
        const sel = r.params[0].data.slice(0,10);
        if (sel === toFunctionSelector("sessionOf(address,uint32)")) result = encodeFunctionResult({ abi: policyAbi, functionName: "sessionOf", result: liveRecord });
        else {
          const fn = ["moduleId() view returns(string)", "paymaster() view returns(address)", "PREPAY_VERSION() view returns(uint256)", "creditOf(address) view returns(uint256)", "reservedOf(address) view returns(uint256)", "bootstrapUsed(address) view returns(bool)"].find(s => toFunctionSelector(s) === sel);
          assert.ok(fn, `Unexpected read ${sel}`);
          const name = fn.slice(0,fn.indexOf("("));
          const value = name === "moduleId" ? "disciple.session-policy.1.4.3" : name === "paymaster" ? d.paymaster : name === "PREPAY_VERSION" ? 5n : name === "creditOf" ? 2_000_000n : name === "bootstrapUsed" ? true : 0n;
          result = encodeFunctionResult({ abi: parseAbi([`function ${fn}`]), functionName: name, result: value } as never);
        }
      }
      return { jsonrpc: "2.0", id: r.id, result };
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  });
  try {
    await session.setPrivyOwner(privateKeyToAccount(key));
    await delay();
    assert.equal(session.oneTapStatus().on, true);
    assert.equal(installed, 0, "chain considers old key healthy");
    const abi = parseAbi(["function approve(address,uint256)", "function buyWithUsdg(address,uint256,uint256,uint256)"]);
    const calls = [{ to: d.usdg, data: encodeFunctionData({ abi, functionName: "approve", args: [d.router, 100_000n] }) },
      { to: d.router, data: encodeFunctionData({ abi, functionName: "buyWithUsdg", args: [zero, 100_000n, 1n, BigInt(validUntil)] }) }];
    await assert.rejects(session.aaSend(calls, {}, { trade: true }), (e: unknown) => e instanceof AAError && e.message === session.ONE_TAP_REFRESH_MSG && e.extra?.detail === "simulation failed: AA24 signature error at [URL redacted]");
    for (let i = 0; i < 50 && installed === 0; i++) await delay();
    assert.equal(trades, 1, "no automatic trade resend");
    assert.equal(cleared, 1, "drop rejected signer even while sessionOf stays active");
    assert.equal(installed, 1, "one owner setup, not an owner fallback trade");
    await delay();
    const saved = JSON.parse(store.get("disciple.aa.sessionKey.v2") ?? "null");
    assert.notEqual(saved?.entityId, oldSession.entityId);
    assert.equal(saved?.policy, oldSession.policy, "no policy widening");
    failure = "simulation failed: SpendCapExceeded";
    await assert.rejects(session.aaSend(calls, {}, { trade: true }), (e: unknown) => e instanceof AAError && e.extra?.spendLimit === true);
    await delay();
    assert.equal(cleared, 1, "spend-cap failures do not replace the session");
    assert.equal(installed, 1);
    failure = "PreExecHookReverted: MinOutTooLow";
    await assert.rejects(session.aaSend(calls, {}, { trade: true }), (e: unknown) => e instanceof AAError && e.code === "Estimate" && e.message === failure && !e.extra?.sessionRequired);
    await delay();
    assert.equal(cleared, 1, "generic hook failure does not prove a stale signer");
    assert.equal(installed, 1, "price/permission failures must not trigger owner setup");
    // A failure arriving after a player renewed must not erase the replacement.
    blockTrade = true;
    const late = session.aaSend(calls, {}, { trade: true });
    for (let i = 0; i < 50 && !rejectTrade; i++) await delay();
    assert.ok(rejectTrade);
    await session.enableOneTap();
    const replacement = JSON.parse(store.get("disciple.aa.sessionKey.v2")!);
    rejectTrade(new AAError("Estimate", "simulation failed: AA24 signature error"));
    await assert.rejects(late, (e: unknown) => e instanceof AAError && e.extra?.sessionRequired === true);
    await delay();
    assert.equal(cleared, 1, "late rejection never clears a newer signer");
    assert.equal(installed, 2, "only the explicit replacement setup was added");
    assert.equal(JSON.parse(store.get("disciple.aa.sessionKey.v2")!).entityId, replacement.entityId);
  } finally {
    await session.aaLogout();
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

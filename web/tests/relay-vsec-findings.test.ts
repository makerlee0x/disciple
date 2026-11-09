/**
 * Vercel Security findings on #264 (Nov 9). No network, no chain ops.
 *  1. Over-cap replays must not touch the global paid-send counter (atomic sender-first budget, refund on rejection).
 *  2. Only our MAv2 SemiModularAccount is admitted: hosted BSO uses the same account check as self-relay.
 */
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from "viem";
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
  process.env.KV_LOCAL_FILE = `/tmp/relay-vsec-${process.pid}.json`;
  return { chain: vi.fn(), code: vi.fn(), slot: vi.fn(), read: vi.fn(), curveOf: vi.fn(), curveInfo: vi.fn() };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({
  getChainId: h.chain, getCode: h.code, getStorageAt: h.slot, readContract: h.read }) }));
vi.mock("../lib/server/gradBuy", async original => ({ ...await original<typeof import("../lib/server/gradBuy")>(), chainGradReads: () => ({
  router: "0x688160633b22012717661545df6299d3d3174ad2", usdg: "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d", curveOf: h.curveOf, curveInfo: h.curveInfo }) }));
import { DECR_IF_POSITIVE_LUA, kv, RELAY_BUDGET_LUA } from "../lib/server/kv";
import { RELAY_GLOBAL_KEY, relaySendBudget } from "../lib/server/relayLockdown";
import { ACCOUNT_PROXY_RUNTIME, checkRelayAccount, type RelayAuthReads } from "../lib/server/relayAuth";
import { checkSponsoredOperation } from "../lib/server/gasSponsorship";
import { ENTRYPOINT_V07, LIGHT_ACCOUNT_V2_FACTORY, MAV2_FACTORY } from "../lib/aa/constants";

const sender = "0x0000000000000000000000000000000000000011" as Address, other = "0x0000000000000000000000000000000000000099" as Address;
const impl = "0x00000000000000000000000000000000000000aa" as Address, foreign = "0x00000000000000000000000000000000000000bb" as Address;
const token = "0x0000000000000000000000000000000000000022" as Address, curve = "0x0000000000000000000000000000000000000033" as Address;
const router = "0x688160633b22012717661545df6299d3d3174ad2" as Address, usdg = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d" as Address;
const SMA = `${ACCOUNT_PROXY_RUNTIME}${sender.slice(2)}` as Hex;
const CUSTOM = "0x6080604052348015600f57600080fd5b50" as Hex;   // arbitrary contract runtime
const senderKey = (s: string) => `relay:paid:sender:${s.toLowerCase()}`;
const count = async (k: string) => Number((await kv().get(k)) ?? 0);

beforeEach(async () => {
  vi.resetAllMocks();
  await kv().del(RELAY_GLOBAL_KEY, senderKey(sender), senderKey(other));
  h.chain.mockResolvedValue(46630); h.code.mockResolvedValue(SMA); h.slot.mockResolvedValue(pad(impl, { size: 32 }));
  h.read.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === "SEMI_MODULAR_ACCOUNT_IMPL" ? impl : (() => { throw new Error(`unexpected ${functionName}`); })());
  h.curveOf.mockResolvedValue(curve); h.curveInfo.mockResolvedValue({ token, quote: usdg, graduated: false });
});

describe("finding 1: sender-limited requests never exhaust the global quota", () => {
  it("over-cap replays leave the global counter unchanged (100 replays after 20 sends)", async () => {
    for (let i = 0; i < 20; i++) await expect(relaySendBudget(sender)).resolves.toBeTypeOf("function");
    expect(await count(RELAY_GLOBAL_KEY)).toBe(20);
    for (let i = 0; i < 100; i++) await expect(relaySendBudget(sender)).rejects.toThrow("rate limited");
    expect(await count(RELAY_GLOBAL_KEY)).toBe(20);                       // was 60 (+ every replay) before the fix
    await expect(relaySendBudget(other)).resolves.toBeTypeOf("function");  // other users keep their quota
    expect(await count(RELAY_GLOBAL_KEY)).toBe(21);
  });
  it("global cap unchanged (60/min) and fail closed; a global-over attempt is not charged", async () => {
    for (let i = 0; i < 60; i++) await relaySendBudget(`0x${(i + 1).toString(16).padStart(40, "0")}`);
    await expect(relaySendBudget(sender)).rejects.toThrow("rate limited");
    expect(await count(RELAY_GLOBAL_KEY)).toBe(60);
    const s = kv(), spy = vi.spyOn(s, "relayBudget").mockRejectedValueOnce(new Error("store offline"));
    await expect(relaySendBudget(sender)).rejects.toThrow("store offline"); spy.mockRestore();
  });
  it("refund gives back exactly one global unit, once, and never below zero", async () => {
    const refund = await relaySendBudget(sender);
    expect(await count(RELAY_GLOBAL_KEY)).toBe(1);
    await refund(); await refund();
    expect(await count(RELAY_GLOBAL_KEY)).toBe(0);
    expect(await count(senderKey(sender))).toBe(1);                       // the sender's own counter keeps the attempt
    expect(await kv().decrIfPositive(RELAY_GLOBAL_KEY)).toBe(0); expect(await count(RELAY_GLOBAL_KEY)).toBe(0);
  });
  it.skipIf(!process.env.TRUST_LUA_PY)("RELAY_BUDGET_LUA / DECR_IF_POSITIVE_LUA (Lua 5.1) match the local Kv", () => {
    const py = `
import json, sys
from lupa import lua51
L = lua51.LuaRuntime()
budget, decr = json.loads(sys.stdin.read())
db = {}
def call(cmd, *a):
    if cmd == "INCR": db[a[0]] = int(db.get(a[0], 0)) + 1; return db[a[0]]
    if cmd == "DECR": db[a[0]] = int(db.get(a[0], 0)) - 1; return db[a[0]]
    if cmd == "EXPIRE": return 1
    if cmd == "GET": return None if a[0] not in db else str(db[a[0]])
L.globals().redis = L.table_from({"call": lambda *a: call(*a)})
def run(script, keys, argv):
    L.globals().KEYS = L.table_from(keys); L.globals().ARGV = L.table_from(argv); return L.execute(script)
out = []
for i in range(25): out.append(run(budget, ["s","g"], ["20","60","60"]))
db["g"] = 60
out.append(run(budget, ["t","g"], ["20","60","60"])); out.append(db["g"])
out.append(run(decr, ["g"], [])); db["z"] = 0; out.append(run(decr, ["z"], [])); out.append(db["z"])
print(json.dumps(out))`;
    const r = JSON.parse(execFileSync(process.env.TRUST_LUA_PY!, ["-c", py], { input: JSON.stringify([RELAY_BUDGET_LUA, DECR_IF_POSITIVE_LUA]) }).toString()) as number[];
    expect(r.slice(0, 20)).toEqual(Array(20).fill(0)); expect(r.slice(20, 25)).toEqual(Array(5).fill(1));
    expect(r[25]).toBe(2); expect(r[26]).toBe(60);           // global over cap: refunded inside the script
    expect(r[27]).toBe(59); expect(r[28]).toBe(0); expect(r[29]).toBe(0);
  });
});

const reads = (): RelayAuthReads => ({ getCode: h.code, getStorageAt: h.slot, readContract: h.read } as unknown as RelayAuthReads);
describe("finding 2: only our MAv2 account is admitted (shared check)", () => {
  it("checkRelayAccount: MAv2 SMA + current MAv2 impl passes; custom code, LightAccount, foreign/upgraded impl, bad slot all reject", async () => {
    await expect(checkRelayAccount({ sender }, reads())).resolves.toBeUndefined();
    h.code.mockResolvedValueOnce(CUSTOM); await expect(checkRelayAccount({ sender }, reads())).rejects.toThrow("unsupported account runtime");
    h.code.mockResolvedValueOnce(ACCOUNT_PROXY_RUNTIME); await expect(checkRelayAccount({ sender }, reads())).rejects.toThrow("unsupported account runtime");
    h.slot.mockResolvedValueOnce(pad(foreign, { size: 32 })); await expect(checkRelayAccount({ sender }, reads())).rejects.toThrow("implementation");
    h.slot.mockResolvedValueOnce(undefined); await expect(checkRelayAccount({ sender }, reads())).rejects.toThrow("implementation");
    h.slot.mockRejectedValueOnce(new Error("rpc down")); await expect(checkRelayAccount({ sender }, reads())).rejects.toThrow("rpc down");
  });
  it("undeployed: our MAv2 factory only; a deployed account can't carry a factory", async () => {
    h.code.mockResolvedValue("0x");
    await expect(checkRelayAccount({ sender, factory: MAV2_FACTORY }, reads())).resolves.toBeUndefined();
    await expect(checkRelayAccount({ sender, factory: LIGHT_ACCOUNT_V2_FACTORY }, reads())).rejects.toThrow("unsupported factory");
    await expect(checkRelayAccount({ sender }, reads())).rejects.toThrow("unsupported factory");
    h.code.mockResolvedValue(SMA);
    await expect(checkRelayAccount({ sender, factory: MAV2_FACTORY }, reads())).rejects.toThrow("cannot include a factory");
  });

  const exec = parseAbi(["function executeBatch((address target,uint256 value,bytes data)[])"]), erc20 = parseAbi(["function approve(address,uint256)"]);
  const buy = parseAbi(["function buyWithUsdg(address,uint256,uint256,uint256)"]);
  const bsoOp = () => ({ sender, nonce: "0x0", maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x0", preVerificationGas: "0x0", callGasLimit: "0x100000", verificationGasLimit: "0x40000", signature: "0x",
    callData: encodeFunctionData({ abi: exec, functionName: "executeBatch", args: [[
      { target: usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [router, 10n] }) },
      { target: router, value: 0n, data: encodeFunctionData({ abi: buy, functionName: "buyWithUsdg", args: [token, 10n, 1n, BigInt(Math.floor(Date.now() / 1000) + 600)] }) }]] }) });
  it("hosted BSO: our MAv2 sender passes; the same canonical calldata from a custom / LightAccount / foreign-impl sender is denied", async () => {
    await expect(checkSponsoredOperation(bsoOp(), ENTRYPOINT_V07)).resolves.toBeUndefined();
    expect(h.slot).toHaveBeenCalled();                                    // the implementation slot is read for BSO now
    for (const arrange of [() => h.code.mockResolvedValue(CUSTOM), () => h.code.mockResolvedValue(ACCOUNT_PROXY_RUNTIME),
      () => h.slot.mockResolvedValue(pad(foreign, { size: 32 })), () => h.code.mockResolvedValue("0x"), () => h.slot.mockRejectedValue(new Error("rpc down"))]) {
      h.code.mockResolvedValue(SMA); h.slot.mockResolvedValue(pad(impl, { size: 32 })); arrange();
      await expect(checkSponsoredOperation(bsoOp(), ENTRYPOINT_V07)).rejects.toThrow("BSO sponsorship admission denied");
    }
  });
  it("hosted BSO: the factory's immutable implementation is read once per instance; code + slot are read fresh every op", async () => {
    h.code.mockClear(); h.slot.mockClear(); h.read.mockClear();
    await checkSponsoredOperation(bsoOp(), ENTRYPOINT_V07); await checkSponsoredOperation(bsoOp(), ENTRYPOINT_V07);
    expect(h.code).toHaveBeenCalledTimes(2); expect(h.slot).toHaveBeenCalledTimes(2);
    expect(h.read.mock.calls.filter(([a]) => (a as { functionName: string }).functionName === "SEMI_MODULAR_ACCOUNT_IMPL")).toHaveLength(0);   // cached from the earlier test's instance client
  });
});

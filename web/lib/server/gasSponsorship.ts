/** Testnet-only BSO admission. No webhook or caller-selected policy/upstream.
 * Canonical decoding (including whole batches) is mandatory: selector scanning is unsafe.
 */
import { createPublicClient, decodeAbiParameters, decodeFunctionData, encodeFunctionData, http, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { accountFactoryAbi, getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress, semiModularAccountBytecodeAbi } from "@account-kit/smart-contracts/experimental";
import { buildCreateSession, buildUninstallSession, TRADE_PERMS } from "@disciple/session-keys";
import { checkBso } from "../aa/bso";
import { accountCalls } from "../aa/gasPolicy";
import { ENTRYPOINT_V07, MAV2_FACTORY } from "../aa/constants";
import { sessionPolicyFor } from "../aa/oneTap";
import { ACTIVE_CHAIN, DEPLOYMENTS, robinhoodTestnet, ZERO } from "../chains";
import { ANON_ADDONS } from "../anon";
import { chainGradReads, type GradReads } from "./gradBuy";
import { checkRelayAccount, type RelayAuthReads } from "./relayAuth";

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fail(): never { throw new Error("BSO sponsorship admission denied"); }
const address = (a: unknown): a is Address => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !eq(a, ZERO);
const exec = parseAbi(["function execute(address,uint256,bytes)", "function executeBatch((address target,uint256 value,bytes data)[])"]);
const tradeAbi = parseAbi([
  "function buyWithUsdg(address,uint256,uint256,uint256)", "function sellToUsdg(address,uint256,uint256,uint256)",
  "function buyExactIn(address,uint256,uint256,address,uint256)", "function sellExactIn(address,uint256,uint256,address,uint256)",
  "function buy(uint256,uint256,uint256)", "function sell(uint256,uint256,uint256)",
  "function buy(uint256,uint256,uint256,address)", "function sell(uint256,uint256,uint256,address)",
]);
const approveAbi = parseAbi(["function approve(address,uint256)"]);
const cfgAbi = parseAbiParameters("uint32 entityId, (uint48 validUntil,uint48 validAfter,uint256 permissions,address router,address launchpad,address anonLauncher,address trampWallManager,address quote0,address quote1,uint128 cap0,uint128 cap1,uint16 maxSlippageBps,address stealthOwner) cfg");

export function bsoPolicyId(): string | undefined {
  if (process.env.GAS_SPONSORSHIP_MODE !== "bso") return undefined;
  if (process.env.VERCEL_ENV === "production" || ACTIVE_CHAIN.id !== 46630) fail();
  const id = process.env.ALCHEMY_BSO_POLICY_ID;
  // This phase approves exactly one testnet policy, never a browser-provided value.
  if (id !== "d38ec347-5eb0-498f-ba1a-842ea308c332") fail();
  return id;
}

/** Exact SDK-produced session install/uninstall only, never broad account self-calls. */
export function checkSessionManagement(data: Hex, nowSec: number): void {
  const policy = sessionPolicyFor(46630); if (!policy) fail();
  const singleSigner = getDefaultSingleSignerValidationModuleAddress(robinhoodTestnet);
  const timeRange = getDefaultTimeRangeModuleAddress(robinhoodTestnet);
  const d = DEPLOYMENTS[46630];
  const modules = { policy, singleSigner, timeRange };
  const decoded = decodeFunctionData({ abi: semiModularAccountBytecodeAbi, data });
  if (decoded.functionName === "uninstallValidation") {
    const [entity] = decoded.args;
    const id = Number(BigInt(`0x${entity.slice(42)}`));
    if (id <= 0 || id >= 2 ** 31 || !eq(buildUninstallSession(id, modules), data)) fail();
    return;
  }
  if (decoded.functionName !== "installValidation") fail();
  const [, , installData, hooks] = decoded.args;
  if (hooks.length !== 3) fail();
  const [entityId, signer] = decodeAbiParameters(parseAbiParameters("uint32,address"), installData);
  const [hookEntity, cfg] = decodeAbiParameters(cfgAbi, `0x${hooks[0].slice(52)}`);
  if (hookEntity !== entityId || !address(signer) || cfg.validUntil <= nowSec || cfg.validUntil > nowSec + 86400 || cfg.permissions !== TRADE_PERMS || cfg.validAfter !== 0) fail();
  if (!eq(cfg.router, d.router) || !eq(cfg.launchpad, d.launchpad) || !eq(cfg.trampWallManager, d.trampWallManager) || !eq(cfg.quote0, d.defaultQuote) || !eq(cfg.quote1, d.usdg) || cfg.cap0 <= 0n || cfg.cap1 <= 0n || !eq(cfg.stealthOwner, ZERO) || !eq(cfg.anonLauncher, ANON_ADDONS[46630].anonLauncher)) fail();
  // Rebuild binds all selector flags, modules, hooks, entity IDs, signer and every config byte.
  const expected = buildCreateSession({ modules, targets: { router: cfg.router, launchpad: cfg.launchpad, anonLauncher: cfg.anonLauncher, trampWallManager: cfg.trampWallManager }, sessionSigner: signer,
    entityId, now: cfg.validUntil - 60, ttlSec: 60, permissions: TRADE_PERMS,
    caps: [{ token: cfg.quote0, cap: cfg.cap0 }, { token: cfg.quote1, cap: cfg.cap1 }], maxSlippageBps: cfg.maxSlippageBps });
  if (!eq(expected.data, data)) fail();
}

export async function checkSponsoredCalls(callData: Hex, sender: Address, reads: GradReads, nowSec: number | Promise<number> = Math.floor(Date.now() / 1000)): Promise<void> {
  // SDK encodes owner account management as direct calldata. It is not an arbitrary execution envelope.
  const raw = callData.startsWith("0x8dd7712f") ? `0x${callData.slice(10)}` as Hex : callData;
  const calls = accountCalls(callData);
  if (!calls) { checkSessionManagement(raw, await nowSec); return; }
  const dec = decodeFunctionData({ abi: exec, data: raw });
  if (!eq(encodeFunctionData({ abi: exec, functionName: dec.functionName, args: dec.args as never }), raw)) fail();
  if (!calls.length || calls.length > 8 || calls.some((c) => c.value !== 0n)) fail();
  if (calls.length === 1 && eq(calls[0].to, sender)) { checkSessionManagement(calls[0].data as Hex, await nowSec); return; }
  const needs = new Map<string, bigint>();
  const approvals = new Map<string, bigint>();
  let trades = 0;
  // Only the immutable token/quote are used here (never graduated): curveMeta when the reads provide it.
  const meta = (curve: string) => reads.curveMeta ? reads.curveMeta(curve) : reads.curveInfo(curve);
  for (const c of calls) {
    const to = c.to as Address, data = c.data as Hex;
    if (data.slice(0, 10) === "0x095ea7b3") {
      const ap = decodeFunctionData({ abi: approveAbi, data });
      const [spender, amount] = ap.args;
      if (!eq(encodeFunctionData({ abi: approveAbi, functionName: "approve", args: ap.args }), data) || amount <= 0n || amount === (1n << 256n) - 1n) fail();
      const k = `${to.toLowerCase()}:${spender.toLowerCase()}`;
      if (approvals.has(k)) fail();
      approvals.set(k, amount); continue;
    }
    const t = decodeFunctionData({ abi: tradeAbi, data });
    if (!eq(encodeFunctionData({ abi: tradeAbi, functionName: t.functionName, args: t.args as never }), data)) fail();
    const a = t.args;
    const router = !!reads.router && eq(to, reads.router);
    let payToken: string, spender: string, amount: bigint, minOut: bigint, deadline: bigint;
    if (router) {
      if (!["buyWithUsdg", "sellToUsdg", "buyExactIn", "sellExactIn"].includes(t.functionName)) fail();
      const token = a[0] as Address;
      if (!address(token)) fail();
      const curve = await reads.curveOf(token); if (!address(curve)) fail();
      const info = await meta(curve);
      if (!eq(info.token, token)) fail();
      payToken = t.functionName === "buyWithUsdg" ? reads.usdg! : t.functionName === "buyExactIn" ? info.quote : token;
      amount = a[1] as bigint; minOut = a[2] as bigint;
      deadline = a[a.length - 1] as bigint;
      if (a.length === 5 && !eq(a[3] as string, sender)) fail();
      spender = to;
    } else {
      if (t.functionName !== "buy" && t.functionName !== "sell") fail();
      const info = await meta(to);
      if (!address(info.token) || !eq(await reads.curveOf(info.token), to)) fail();
      payToken = t.functionName === "buy" ? info.quote : info.token;
      spender = to; amount = a[0] as bigint; minOut = a[1] as bigint; deadline = a[2] as bigint;
      if (a.length === 4 && !eq(a[3] as string, sender)) fail();
    }
    const now = await nowSec;
    if (!address(payToken) || amount <= 0n || minOut <= 0n || deadline <= BigInt(now) || deadline > BigInt(now + 3600)) fail();
    const k = `${payToken.toLowerCase()}:${spender.toLowerCase()}`;
    // Approval must precede its consuming trade; exact total checked after the whole batch.
    if (!approvals.has(k)) fail();
    needs.set(k, (needs.get(k) ?? 0n) + amount); trades++;
  }
  if (!trades || approvals.size !== needs.size || [...approvals].some(([k, n]) => needs.get(k) !== n)) fail();
}

export async function checkSponsoredOperation(op: Record<string, unknown>, entryPoint: unknown, estimate = false): Promise<void> {
  checkBso(op, estimate);
  if (typeof entryPoint !== "string" || !eq(entryPoint, ENTRYPOINT_V07) || !address(op.sender) || typeof op.callData !== "string" || op.initCode !== undefined || op.eip7702Auth !== undefined) fail();
  const pc = bsoClient();
  if (await pc.getChainId() !== 46630) fail();
  if (op.factory !== undefined || op.factoryData !== undefined) {
    if (typeof op.factory !== "string" || !eq(op.factory, MAV2_FACTORY) || typeof op.factoryData !== "string") fail();
    const data = op.factoryData as Hex;
    const f = decodeFunctionData({ abi: accountFactoryAbi, data });
    if (f.functionName !== "createSemiModularAccount" || !eq(encodeFunctionData({ abi: accountFactoryAbi, functionName: f.functionName, args: f.args }), data)) fail();
    const expected = await pc.readContract({ address: MAV2_FACTORY, abi: accountFactoryAbi, functionName: "getAddressSemiModular", args: f.args });
    if (!eq(expected, op.sender)) fail();
    await checkSponsoredCalls(op.callData as Hex, op.sender, chainGradReads(pc, 46630));
    return;
  }
  // Vercel Security finding 2: a deployed sender must be OUR MAv2 account (runtime template + current ERC-1967 slot ==
  // MAv2 impl), the same check self-relay runs; any other bytecode would make the MAv2-envelope parse below meaningless.
  // Runs concurrently with the call-allowlist parse (was a sequential getCode before it); both must pass.
  await Promise.all([
    checkRelayAccount({ sender: op.sender as Address, factory: undefined }, pc as unknown as RelayAuthReads).catch(() => fail()),
    checkSponsoredCalls(op.callData as Hex, op.sender, chainGradReads(pc, 46630)),
  ]);
}
// One client per instance (same transport/options as before) so the MAv2 factory's immutable implementation getter is
// read once per instance (relayAuth caches it per client); the sender's code + implementation slot stay fresh per op.
const makeBsoClient = () => createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { timeout: 5000, retryCount: 0 }) });
let bso: ReturnType<typeof makeBsoClient> | undefined;
function bsoClient() { return (bso ??= makeBsoClient()); }

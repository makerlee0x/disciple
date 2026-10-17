/**
 * @disciple/session-keys — create / use / revoke DISCIPLE one-tap session keys on an Alchemy Modular Account v2
 * (SemiModularAccount). On-chain enforcement lives in contracts/src/session/DiscipleSessionPolicy.sol.
 *
 * Install layout (one `installValidation` call signed by the OWNER):
 *   validation:  Alchemy SingleSignerValidation(entityId, signer = session key)   non-global, execute/executeBatch only
 *   hook #1:     DiscipleSessionPolicy  VALIDATION hook, entityId                   (targets/selectors/expiry, ERC-7562-safe)
 *   hook #2:     DiscipleSessionPolicy  EXECUTION hook, entityId | 2^31             (curve registry, recipient/spender pinning, cap)
 *   hook #3:     Alchemy TimeRange      VALIDATION hook (optional, defense in depth)
 *
 * Nothing here holds or logs secrets: callers pass addresses and get calldata back.
 */
import {
  concat, encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector,
  type Address, type Hex, type PublicClient,
} from "viem";
import {
  HookType, SingleSignerValidationModule, TimeRangeModule,
  semiModularAccountBytecodeAbi, serializeHookConfig, serializeModuleEntity, serializeValidationConfig,
} from "@account-kit/smart-contracts/experimental";

export const EXEC_HOOK_FLAG = 2 ** 31;
export const DEFAULT_TTL_SEC = 24 * 60 * 60;
export const MAX_TTL_SEC = 24 * 60 * 60; // DiscipleSessionPolicy.MAX_SESSION_DURATION (enforced on-chain)
export const DEFAULT_MAX_SLIPPAGE_BPS = 500;
export const MIN_SLIPPAGE_BPS = 10; // 0.1% — DiscipleSessionPolicy.MIN_SLIPPAGE_BPS_LIMIT
export const MAX_SLIPPAGE_BPS = 5000;

/** Permission bits — must match DiscipleSessionPolicy.P_* */
export const Perm = {
  ROUTER_BUY: 1n << 0n, ROUTER_SELL: 1n << 1n, CURVE_BUY: 1n << 2n, CURVE_SELL: 1n << 3n,
  TRAMP: 1n << 4n, WALL: 1n << 5n, CANCEL: 1n << 6n, LAUNCH: 1n << 7n, ANON_LAUNCH: 1n << 8n, APPROVE: 1n << 9n,
  REFERRAL: 1n << 10n,
} as const;
/** Default "quick trade" set: buy/sell (router + curves), tramps/walls/cancel, approve. Launches are opt-in. */
export const TRADE_PERMS = Perm.ROUTER_BUY | Perm.ROUTER_SELL | Perm.CURVE_BUY | Perm.CURVE_SELL |
  Perm.TRAMP | Perm.WALL | Perm.CANCEL | Perm.APPROVE;

/** Config-driven DISCIPLE addresses (take them from contracts/deployments/<chain>.json, never hard-code). */
export type DiscipleTargets = { router: Address; launchpad: Address; anonLauncher?: Address; trampWallManager: Address };
export type QuoteCap = { token: Address; cap: bigint };

export type Modules = {
  policy: Address;               // deployed DiscipleSessionPolicy
  singleSigner: Address;         // Alchemy SingleSignerValidation (getDefaultSingleSignerValidationModuleAddress)
  timeRange?: Address;           // Alchemy TimeRange (optional extra expiry hook)
};

export type CreateSessionParams = {
  modules: Modules;
  targets: DiscipleTargets;
  sessionSigner: Address;        // public address of the browser-held session key
  caps: [QuoteCap] | [QuoteCap, QuoteCap];
  entityId?: number;             // default: random in [1, 2^31)
  ttlSec?: number;               // default 24h, max 24h (on-chain limit)
  permissions?: bigint;          // default TRADE_PERMS
  maxSlippageBps?: number;       // buys/sells need minOut >= on-chain quote * (1 - bps); default 500, range [10, 5000]
  now?: number;                  // unix seconds (tests)
};

export const policyAbi = parseAbi([
  "function revoke(uint32 entityId)",
  "function sessionOf(address account, uint32 entityId) view returns (((uint48 validUntil,uint48 validAfter,uint256 permissions,address router,address launchpad,address anonLauncher,address trampWallManager,address quote0,address quote1,uint128 cap0,uint128 cap1,uint16 maxSlippageBps) cfg,uint128 spent0,uint128 spent1,bool active))",
  "event SessionSpend(address indexed account, uint32 indexed entityId, address quote, uint256 amount, uint256 spent)",
]);

const sessionCfgAbi = [{
  type: "tuple", components: [
    { name: "validUntil", type: "uint48" }, { name: "validAfter", type: "uint48" }, { name: "permissions", type: "uint256" },
    { name: "router", type: "address" }, { name: "launchpad", type: "address" }, { name: "anonLauncher", type: "address" },
    { name: "trampWallManager", type: "address" }, { name: "quote0", type: "address" }, { name: "quote1", type: "address" },
    { name: "cap0", type: "uint128" }, { name: "cap1", type: "uint128" }, { name: "maxSlippageBps", type: "uint16" },
  ],
}] as const;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SESSION_SELECTORS = [toFunctionSelector("execute(address,uint256,bytes)"), toFunctionSelector("executeBatch((address,uint256,bytes)[])")];

export function randomEntityId(): number {
  const b = new Uint32Array(1); crypto.getRandomValues(b);
  return (b[0] % (EXEC_HOOK_FLAG - 2)) + 1;
}

export function encodePolicyInstallData(entityId: number, p: Required<Pick<CreateSessionParams, "targets" | "caps">> & { validUntil: number; validAfter?: number; permissions: bigint; maxSlippageBps?: number }): Hex {
  const [q0, q1] = p.caps;
  return encodeAbiParameters([{ type: "uint32" }, ...sessionCfgAbi], [entityId, {
    validUntil: p.validUntil, validAfter: p.validAfter ?? 0, permissions: p.permissions,
    router: p.targets.router, launchpad: p.targets.launchpad, anonLauncher: p.targets.anonLauncher ?? ZERO,
    trampWallManager: p.targets.trampWallManager,
    quote0: q0.token, quote1: q1?.token ?? ZERO, cap0: q0.cap, cap1: q1?.cap ?? 0n,
    maxSlippageBps: p.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
  }]);
}

/** Calldata the OWNER must send to the account (self-call) to install a session. */
export function buildCreateSession(p: CreateSessionParams) {
  const ttl = p.ttlSec ?? DEFAULT_TTL_SEC;
  if (ttl <= 0 || ttl > MAX_TTL_SEC) throw new Error(`ttlSec must be in (0, ${MAX_TTL_SEC}]`);
  if (!p.caps.length || p.caps.some((c) => c.cap <= 0n)) throw new Error("every quote cap must be > 0");
  const entityId = p.entityId ?? randomEntityId();
  if (entityId <= 0 || entityId >= EXEC_HOOK_FLAG) throw new Error("entityId must be in [1, 2^31)");
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const validUntil = now + ttl;
  const permissions = p.permissions ?? TRADE_PERMS;
  const maxSlippageBps = p.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < MIN_SLIPPAGE_BPS || maxSlippageBps > MAX_SLIPPAGE_BPS) throw new Error(`maxSlippageBps must be in [${MIN_SLIPPAGE_BPS}, ${MAX_SLIPPAGE_BPS}]`);
  const policyData = encodePolicyInstallData(entityId, { targets: p.targets, caps: p.caps, validUntil, permissions, maxSlippageBps });

  const hooks: Hex[] = [
    concat([serializeHookConfig({ address: p.modules.policy, entityId, hookType: HookType.VALIDATION, hasPreHooks: true, hasPostHooks: false }), policyData]),
    concat([serializeHookConfig({ address: p.modules.policy, entityId: entityId + EXEC_HOOK_FLAG, hookType: HookType.EXECUTION, hasPreHooks: true, hasPostHooks: false }),
      encodeAbiParameters([{ type: "uint32" }], [entityId + EXEC_HOOK_FLAG])]),
  ];
  if (p.modules.timeRange) {
    hooks.push(concat([serializeHookConfig({ address: p.modules.timeRange, entityId, hookType: HookType.VALIDATION, hasPreHooks: true, hasPostHooks: false }),
      TimeRangeModule.encodeOnInstallData({ entityId, validUntil, validAfter: 0 })]));
  }
  const data = encodeFunctionData({
    abi: semiModularAccountBytecodeAbi, functionName: "installValidation",
    args: [
      serializeValidationConfig({ moduleAddress: p.modules.singleSigner, entityId, isGlobal: false, isSignatureValidation: false, isUserOpValidation: true }),
      SESSION_SELECTORS, SingleSignerValidationModule.encodeOnInstallData({ entityId, signer: p.sessionSigner }), hooks,
    ],
  });
  return { entityId, validUntil, permissions, maxSlippageBps, data };
}

/** Owner: fully remove the session (validation + all hooks, storage cleared). Preferred "End session". */
export function buildUninstallSession(entityId: number, modules: Modules): Hex {
  const u = (e: number) => encodeAbiParameters([{ type: "uint32" }], [e]);
  const hookData = [u(entityId), u(entityId + EXEC_HOOK_FLAG)];
  if (modules.timeRange) hookData.push(u(entityId));
  return encodeFunctionData({
    abi: semiModularAccountBytecodeAbi, functionName: "uninstallValidation",
    args: [serializeModuleEntity({ moduleAddress: modules.singleSigner, entityId }), u(entityId), hookData],
  });
}

/** Owner: cheap kill switch (one SSTORE) — account.execute(policy, 0, revoke(entityId)). Uninstall later to clean up. */
export function buildRevokeSession(entityId: number, policy: Address): Hex {
  return encodeFunctionData({ abi: semiModularAccountBytecodeAbi, functionName: "execute",
    args: [policy, 0n, encodeFunctionData({ abi: policyAbi, functionName: "revoke", args: [entityId] })] });
}

export type SessionInfo = { maxSlippageBps: number; active: boolean; validUntil: number; permissions: bigint; spent: bigint[]; caps: bigint[]; quotes: Address[] };
export async function readSession(pc: PublicClient, policy: Address, account: Address, entityId: number): Promise<SessionInfo> {
  const s = await pc.readContract({ address: policy, abi: policyAbi, functionName: "sessionOf", args: [account, entityId] });
  const now = Math.floor(Date.now() / 1000);
  return {
    maxSlippageBps: s.cfg.maxSlippageBps, active: s.active && Number(s.cfg.validUntil) > now, validUntil: Number(s.cfg.validUntil), permissions: s.cfg.permissions,
    quotes: [s.cfg.quote0, s.cfg.quote1], caps: [s.cfg.cap0, s.cfg.cap1], spent: [s.spent0, s.spent1],
  };
}

/**
 * minOut for a session trade from an off-chain quote (router.quoteExactIn / curve.quoteBuy|quoteSell via eth_call).
 * Use a slippage <= the session's maxSlippageBps so the on-chain check (quote at execution) still passes if the
 * price moves slightly in your favour; never returns 0.
 */
export function minOutFor(quotedOut: bigint, slippageBps: number): bigint {
  if (quotedOut <= 0n) throw new Error("quote is zero");
  const m = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return m > 0n ? m : 1n;
}

/* ---------- call builders for the session key (always recipient = account) ---------- */
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const routerAbi = parseAbi([
  "function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)",
  "function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) returns (uint256)",
]);
export type Call = { target: Address; value: bigint; data: Hex };

export function routerBuyCalls(a: { account: Address; router: Address; quote: Address; token: Address; quoteIn: bigint; minOut: bigint; deadline: bigint }): Call[] {
  return [
    { target: a.quote, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [a.router, a.quoteIn] }) },
    { target: a.router, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "buyExactIn", args: [a.token, a.quoteIn, a.minOut, a.account, a.deadline] }) },
  ];
}
export function routerSellCalls(a: { account: Address; router: Address; token: Address; tokensIn: bigint; minOut: bigint; deadline: bigint }): Call[] {
  return [
    { target: a.token, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [a.router, a.tokensIn] }) },
    { target: a.router, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "sellExactIn", args: [a.token, a.tokensIn, a.minOut, a.account, a.deadline] }) },
  ];
}
/* ---------- USDG-in / USDG-out (DiscipleRouter.buyWithUsdg / sellToUsdg) ----------
 * The frontend always pays in USDG; the router hops USDG <-> the coin's quote through an owner-registered pool, then
 * the curve (pre-grad) or the coin's v4 pool (post-grad). Recipient is pinned on-chain to msg.sender (the account).
 * minOut is END-TO-END: tokens on buys, USDG on sells. Quote it with `quoteUsdgRouteFor(account, …)` (eth_call /
 * simulateContract) so PVE login / NET caps / profit tax are evaluated for the smart account (the session policy
 * checks minOut against exactly that quote). `quoteUsdgRoute` quotes for the eth_call `from`.
 * The session policy only accepts a USDG approve to the router for EXACTLY the batch's buyWithUsdg total, so always
 * send the approve and the buy in the same batch (these builders do). No Permit2 / UniversalRouter. */
export const usdgRouterAbi = parseAbi([
  "function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline) returns (uint256 tokensOut)",
  "function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline) returns (uint256 usdgOut)",
  "function quoteUsdgRoute(address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 maxHopImpactBps)",
  "function quoteUsdgRouteFor(address trader, address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 maxHopImpactBps)",
  "function usdg() view returns (address)",
]);

/** eth_call data for the end-to-end USDG route quote for `trader` (audit M2): the quote applies that trader's
 *  PVE gate / caps / profit tax, the same account the session policy quotes for when checking minOut. */
export function encodeQuoteUsdgRouteFor(a: { trader: Address; token: Address; isBuy: boolean; amountIn: bigint }): Hex {
  return encodeFunctionData({ abi: usdgRouterAbi, functionName: "quoteUsdgRouteFor", args: [a.trader, a.token, a.isBuy, a.amountIn] });
}

export function routerBuyWithUsdgCalls(a: { router: Address; usdg: Address; token: Address; usdgIn: bigint; minTokensOut: bigint; deadline: bigint }): Call[] {
  if (a.minTokensOut <= 0n) throw new Error("minTokensOut must be > 0");
  return [
    { target: a.usdg, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [a.router, a.usdgIn] }) },
    { target: a.router, value: 0n, data: encodeFunctionData({ abi: usdgRouterAbi, functionName: "buyWithUsdg", args: [a.token, a.usdgIn, a.minTokensOut, a.deadline] }) },
  ];
}
export function routerSellToUsdgCalls(a: { router: Address; token: Address; tokensIn: bigint; minUsdgOut: bigint; deadline: bigint }): Call[] {
  if (a.minUsdgOut <= 0n) throw new Error("minUsdgOut must be > 0");
  return [
    { target: a.token, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [a.router, a.tokensIn] }) },
    { target: a.router, value: 0n, data: encodeFunctionData({ abi: usdgRouterAbi, functionName: "sellToUsdg", args: [a.token, a.tokensIn, a.minUsdgOut, a.deadline] }) },
  ];
}

/** Account calldata for a session-signed batch (use as userOp.callData, signed by the session key with entityId). */
export function encodeSessionBatch(calls: Call[]): Hex {
  return encodeFunctionData({ abi: semiModularAccountBytecodeAbi, functionName: "executeBatch", args: [calls] });
}
export * from "./modes";

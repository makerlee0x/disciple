import { test } from "node:test";
import assert from "node:assert";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { semiModularAccountBytecodeAbi } from "@account-kit/smart-contracts/experimental";
import { encodeQuoteUsdgRouteFor, routerBuyWithUsdgCalls, routerSellToUsdgCalls, usdgRouterAbi, buildCreateSession, buildUninstallSession, EXEC_HOOK_FLAG, encodePolicyInstallData, TRADE_PERMS } from "../src/index.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const targets = { router: A(1), launchpad: A(2), anonLauncher: A(3), trampWallManager: A(4) };
const modules = { policy: A(9), singleSigner: A(8), timeRange: A(7) };

test("install calldata: non-global SingleSigner + policy validation & execution hooks + TimeRange", () => {
  const r = buildCreateSession({ modules, targets, sessionSigner: A(5), caps: [{ token: A(6), cap: 100n }], entityId: 8, now: 1_800_000_000 });
  assert.equal(r.validUntil, 1_800_000_000 + 86400);
  const d = decodeFunctionData({ abi: semiModularAccountBytecodeAbi, data: r.data });
  assert.equal(d.functionName, "installValidation");
  const [vcfg, sels, , hooks] = d.args as [string, string[], string, string[]];
  assert.equal(vcfg.toLowerCase(), (A(8) + "00000008" + "01").toLowerCase()); // userOp-only, not global
  assert.deepEqual(sels, ["0xb61d27f6", "0x34fcd5be"]);
  assert.equal(hooks.length, 3);
  assert.ok(hooks[1].toLowerCase().startsWith((A(9) + (8 + EXEC_HOOK_FLAG).toString(16) + "04").toLowerCase()));
  assert.ok(hooks[0].toLowerCase().startsWith((A(9) + "00000008" + "05").toLowerCase()));
});

test("rejects bad ttl / caps", () => {
  assert.throws(() => buildCreateSession({ modules, targets, sessionSigner: A(5), caps: [{ token: A(6), cap: 0n }] }));
  assert.throws(() => buildCreateSession({ modules, targets, sessionSigner: A(5), caps: [{ token: A(6), cap: 1n }], ttlSec: 30 * 86400 }));
});

test("audit #7: limits match DiscipleSessionPolicy (ttl <= 24h, slippage 10..5000)", () => {
  const base = { modules, targets, sessionSigner: A(5), caps: [{ token: A(6), cap: 1n }] as [{ token: `0x${string}`; cap: bigint }] };
  assert.throws(() => buildCreateSession({ ...base, ttlSec: 86400 + 1 }));
  assert.doesNotThrow(() => buildCreateSession({ ...base, ttlSec: 86400 }));
  assert.throws(() => buildCreateSession({ ...base, maxSlippageBps: 9 }));
  assert.doesNotThrow(() => buildCreateSession({ ...base, maxSlippageBps: 10 }));
  assert.throws(() => buildCreateSession({ ...base, maxSlippageBps: 5001 }));
});

test("uninstall + fixture for forge", () => {
  assert.equal(decodeFunctionData({ abi: semiModularAccountBytecodeAbi, data: buildUninstallSession(8, modules) }).functionName, "uninstallValidation");
  assert.equal(encodePolicyInstallData(8, { targets, caps: [{ token: A(6), cap: 100n }], validUntil: 1_800_086_400, permissions: TRADE_PERMS }), FIXTURE);
});
const FIXTURE = "0x0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000006b4b23800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000027f0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f40000000000000000000000000000000000000000000000000000000000000000";

test("USDG router encoders: exact approve + buyWithUsdg / sellToUsdg, selectors pinned", () => {
  const b = routerBuyWithUsdgCalls({ router: A(1), usdg: A(6), token: A(7), usdgIn: 50n, minTokensOut: 10n, deadline: 99n });
  assert.equal(b.length, 2);
  assert.equal(b[0].target, A(6));
  assert.equal(b[0].data.slice(0, 10), "0x095ea7b3");
  const d = decodeFunctionData({ abi: usdgRouterAbi, data: b[1].data });
  assert.equal(d.functionName, "buyWithUsdg");
  assert.deepEqual(d.args, [A(7), 50n, 10n, 99n]);
  const s = routerSellToUsdgCalls({ router: A(1), token: A(7), tokensIn: 5n, minUsdgOut: 1n, deadline: 99n });
  assert.equal(decodeFunctionData({ abi: usdgRouterAbi, data: s[1].data }).functionName, "sellToUsdg");
  assert.throws(() => routerBuyWithUsdgCalls({ router: A(1), usdg: A(6), token: A(7), usdgIn: 1n, minTokensOut: 0n, deadline: 1n }));
});

test("quoteUsdgRouteFor encoder: trader is the first arg (audit M2)", () => {
  const data = encodeQuoteUsdgRouteFor({ trader: A(1), token: A(2), isBuy: true, amountIn: 5n });
  assert.equal(data.slice(0, 10), toFunctionSelector("function quoteUsdgRouteFor(address,address,bool,uint256)"));
  assert.equal(data.slice(10, 74), A(1).slice(2).toLowerCase().padStart(64, "0"));
});

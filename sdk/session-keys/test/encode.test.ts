import { test } from "node:test";
import assert from "node:assert";
import { decodeFunctionData } from "viem";
import { semiModularAccountBytecodeAbi } from "@account-kit/smart-contracts/experimental";
import { buildCreateSession, buildUninstallSession, EXEC_HOOK_FLAG, encodePolicyInstallData, TRADE_PERMS } from "../src/index.ts";

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

test("uninstall + fixture for forge", () => {
  assert.equal(decodeFunctionData({ abi: semiModularAccountBytecodeAbi, data: buildUninstallSession(8, modules) }).functionName, "uninstallValidation");
  assert.equal(encodePolicyInstallData(8, { targets, caps: [{ token: A(6), cap: 100n }], validUntil: 1_800_086_400, permissions: TRADE_PERMS }), FIXTURE);
});
const FIXTURE = "0x0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000006b4b23800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000027f00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000";

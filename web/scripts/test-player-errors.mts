// Player-facing error copy (lee 2026-10-24, "clean up the rest of the jargon"): every path a player can see maps to
// curated copy or the approved plain line — never ids, hex, contract / function names or chain plumbing wording —
// and the raw detail goes to console.warn("[disciple] …"). Error codes / attached data stay as they were.
//   pnpm test:player-errors   (pure; no RPC, nothing broadcast)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeErrorResult, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const warned: unknown[][] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a); };
test.after(() => { console.warn = realWarn; });

const { AAError, LightSmartAccount } = await import("../lib/aa/core");
const { friendlyError, CREATOR_BUY_MSG } = await import("../lib/protocol-viem");
const { playerError } = await import("../lib/playerError");
const { claimErrorText } = await import("../lib/claims/common");
const { plainText, JARGON } = await import("../lib/aa/relayOp");

// approved by lee 2026-10-24 — asserted verbatim
const REJECTED = "That didn't go through. Try again.";
const PENDING = "Still confirming. Check back in a moment.";
// pending lee's approval (PR body)
const GRADUATED = "This rocket has ASCENDED, so trading moved to its pool.";
const CREATOR_BUY = "Your launch buy is over the max for this rocket. Try a smaller amount.";
const QUOTE_REJECTED = "That pair token can't be used. Pick another quote token.";

const H = ("0x" + "ab".repeat(32)) as Hex, ADDR = "0x00000000000000000000000000000000000000aa";
/** no ids / hex / contract or function names / plumbing words */
function plain(m: string) {
  assert.doesNotMatch(m, /0x[0-9a-f]{3,}/i, `hex leaked: ${m}`);
  assert.doesNotMatch(m, /\b(user ?op|userop|tx|relay(er)?|on-?chain|simulat\w*|bundl\w*|AA\d{2}|v4|rpc|eth_\w+|entrypoint|nonce|selector|reverted)\b/i, `jargon leaked: ${m}`);
  assert.doesNotMatch(m, /\w+\.\w+\(\)|\b[A-Z][a-z]+[A-Z]\w+\b/, `contract/function name leaked: ${m}`);
}
const logged = (re: RegExp) => warned.some((w) => String(w[0]).startsWith("[disciple] ") && re.test(JSON.stringify(w.slice(1), (_k, v) => typeof v === "bigint" ? String(v) : v)));
const est = (revertData?: Hex, msg = "simulation failed: execution reverted") => new AAError("Estimate", msg, revertData ? { revertData } : {});

test("FailedOp raw reason (AA2x …) → plain line; reason to console", () => {
  warned.length = 0;
  const fo = encodeErrorResult({ abi: parseAbi(["error FailedOp(uint256 opIndex, string reason)"]), errorName: "FailedOp", args: [BigInt(0), "AA23 reverted (or OOG)"] });
  const pe = friendlyError(est(fo));
  assert.equal(pe.code, "FailedOp"); assert.equal(pe.message, REJECTED); plain(pe.message);
  assert.ok(logged(/AA23 reverted/), "raw reason logged");
});

test("raw revert text reason (Error(string)) → plain line; text to console", () => {
  warned.length = 0;
  const rd = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["TransferHelper: TRANSFER_FROM_FAILED"] });
  const pe = friendlyError(est(rd));
  assert.equal(pe.code, "Error"); assert.equal(pe.message, REJECTED); plain(pe.message);
  assert.ok(logged(/TRANSFER_FROM_FAILED/));
});

test("unmapped contract error name → plain line, the name only in the console", () => {
  warned.length = 0;
  const rd = encodeErrorResult({ abi: parseAbi(["error CurveDeployerUnset()"]), errorName: "CurveDeployerUnset" });
  const pe = friendlyError(est(rd));
  assert.equal(pe.code, "CurveDeployerUnset", "error code kept");
  assert.equal(pe.message, REJECTED); plain(pe.message);
  assert.ok(logged(/CurveDeployerUnset/));
});

test("creator-buy cap: plain limit, % of supply when known, no Launchpad.creatorBuyMaxBps()", () => {
  const rd = encodeErrorResult({ abi: parseAbi(["error CreatorBuyTooLarge()"]), errorName: "CreatorBuyTooLarge" });
  const pe = friendlyError(est(rd));
  assert.equal(pe.code, "CreatorBuyTooLarge"); assert.equal(pe.message, CREATOR_BUY); plain(pe.message);
  assert.equal(CREATOR_BUY_MSG(0.77), "Your launch buy is over the max for this rocket (0.77% of supply). Try a smaller amount.");
  plain(CREATOR_BUY_MSG(0.25));
  const src = readFileSync(new URL("../lib/protocol-viem.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "").match(/ProtocolError\("CreatorBuyTooLarge"[^;]*/)?.[0] ?? "", /creatorBuyMaxBps\(\)/);
});

test("Graduated: no 'v4 pool'", () => {
  const pe = friendlyError(est(encodeErrorResult({ abi: parseAbi(["error Graduated()"]), errorName: "Graduated" })));
  assert.equal(pe.message, GRADUATED); plain(pe.message);
});

test("QuoteRejected keeps its copy but drops the raw detail (detail/address → console)", () => {
  warned.length = 0;
  const pe = friendlyError(est(encodeErrorResult({ abi: parseAbi(["error QuoteRejected(string detail)"]), errorName: "QuoteRejected", args: [`quote ${ADDR} not allowlisted`] })));
  assert.equal(pe.message, QUOTE_REJECTED); plain(pe.message);
  assert.ok(logged(/00000000000000000000000000000000000000aa/i));
});

test("mapped errors keep their specific copy (WalletCap, Slippage, balance, MinOutTooLow)", () => {
  const E = parseAbi(["error WalletCap()", "error Slippage()", "error MinOutTooLow(uint256,uint256)", "error ERC20InsufficientBalance(address,uint256,uint256)"]);
  const cases: [Hex, string][] = [
    [encodeErrorResult({ abi: E, errorName: "WalletCap" }), "Wallet cap reached: one wallet can hold at most 7% before orbit."],
    [encodeErrorResult({ abi: E, errorName: "Slippage" }), "Price moved, trade not sent. Try again."],
    [encodeErrorResult({ abi: E, errorName: "MinOutTooLow", args: [BigInt(1), BigInt(2)] }), "Price moved, trade not sent. Try again."],
    [encodeErrorResult({ abi: E, errorName: "ERC20InsufficientBalance", args: [ADDR, BigInt(0), BigInt(1)] }), "Not enough balance for that shot size — deposit more or pick a smaller ammo."],
  ];
  for (const [rd, want] of cases) { const m = friendlyError(est(rd)).message; assert.equal(m, want); plain(m); }
});

test("core.ts: raw '<method>: <RPC error>' (Bundler) → plain line; rpcError kept on the error", () => {
  warned.length = 0;
  const e = new AAError("Bundler", "eth_sendUserOperation: AA25 invalid account nonce 0x1f", { rpcError: { code: -32500, message: "AA25 invalid account nonce" } });
  const pe = friendlyError(e);
  assert.equal(pe.code, "Bundler"); assert.equal(pe.message, REJECTED); plain(pe.message);
  assert.equal(e.message, "eth_sendUserOperation: AA25 invalid account nonce 0x1f", "raw text kept for retry checks");
  assert.ok(logged(/AA25/));
  assert.equal(playerError(e), REJECTED);
});

// drive the real LightSmartAccount.sendCalls with a fake bundler (build / gas steps stubbed)
const op = { sender: ADDR, nonce: "0x1", callData: "0x", callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", signature: "0x" };
function lightAccount(receipt: (i: number) => unknown) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const sa = new LightSmartAccount({ pc: {} as never, chainId: 46630, owner: { address: owner.address, signMessage: (a: never) => owner.signMessage(a) } as never,
    bundler: { async rpc(m: string) { if (m === "eth_sendUserOperation") return H; if (m === "eth_getUserOperationReceipt") return receipt(0); throw new Error(m); } } });
  Object.assign(sa, { buildUserOp: async () => ({ ...op }), selfPayGas: async () => undefined });
  return sa;
}
const fastTimers = async <T,>(f: () => Promise<T>) => {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as typeof setTimeout;
  try { return await f(); } finally { globalThis.setTimeout = real; }
};

test("core.ts: 'UserOp reverted (tx 0x…)' → plain line; ids on extra + console", async () => {
  warned.length = 0;
  const tx = ("0x" + "cd".repeat(32)) as Hex;
  const e = await fastTimers(() => lightAccount(() => ({ success: false, receipt: { transactionHash: tx, logs: [] } })).sendCalls([]).then(() => assert.fail("should throw"), (x) => x as InstanceType<typeof AAError>));
  assert.equal(e.code, "Reverted"); assert.equal(e.message, REJECTED); assert.equal(e.extra?.txHash, tx); assert.equal(e.extra?.userOpHash, H);
  assert.equal(friendlyError(e).message, REJECTED); plain(playerError(e));
  assert.ok(logged(new RegExp(tx.slice(2))));
});

test("core.ts: 'UserOp 0x… not mined yet' → the approved pending line; id on extra + console", async () => {
  warned.length = 0;
  const e = await fastTimers(() => lightAccount(() => null).sendCalls([]).then(() => assert.fail("should throw"), (x) => x as InstanceType<typeof AAError>));
  assert.equal(e.code, "Timeout"); assert.equal(e.message, PENDING); assert.equal(e.extra?.userOpHash, H);
  assert.equal(playerError(e), PENDING); plain(playerError(e));
  assert.ok(logged(new RegExp(H.slice(2))));
  // an older/unplain Timeout text still maps to the pending line
  assert.equal(friendlyError(new AAError("Timeout", `UserOp ${H} not mined yet`)).message, PENDING);
});

test("wallet.ts (EOA): 'Transaction reverted (0x…)' replaced by the plain line, hash on .txHash + console", () => {
  const src = readFileSync(new URL("../lib/wallet.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Transaction reverted \(/);
  assert.match(src, /new Error\(REJECTED_MSG\), \{ txHash: hash \}/);
  assert.match(src, /console\.warn\("\[disciple\] trade reverted", \{ txHash: hash \}\)/);
  // and an old-style message from anywhere is reworded by the display layer
  assert.equal(playerError(new Error(`Transaction reverted (${H})`)), REJECTED);
});

test("protocol-viem: launch with no Launched event → plain line, tx hash to console only", () => {
  const src = readFileSync(new URL("../lib/protocol-viem.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Launch tx \$\{/);
  assert.match(src, /logTradeError\("launch had no Launched event", \{ txHash: r\.txHash \}\); throw new ProtocolError\("NoLaunchEvent", REJECTED_MSG\)/);
});

test("playerError (CashPanel withdraw, WalletButton, create page): plain passes, raw → plain line, rejection → Cancelled.", () => {
  warned.length = 0;
  assert.equal(playerError(new Error("Sign in first.")), "Sign in first.");
  assert.equal(playerError(new AAError("FundAccount", "Your account is still getting ready. Try again in a moment.")), "Your account is still getting ready. Try again in a moment.");
  assert.equal(playerError(new Error("User rejected the request.")), "Cancelled.");
  for (const raw of ["simulation failed: execution reverted (0xdeadbeef)", "relayer not configured", "HTTP request failed. URL: https://rpc… eth_call", "ContractFunctionExecutionError: transfer(address,uint256) reverted", "Transfer(): nonce too low", "ERC20InsufficientBalance"]) {
    const m = playerError(new Error(raw)); assert.equal(m, REJECTED, raw); plain(m);
  }
  assert.ok(logged(/relayer not configured/));
});

test("claims (claimErrorText): mapped copy kept; raw revert strings / messages → plain line", () => {
  assert.equal(claimErrorText(new Error("User rejected the request")), "Cancelled.");
  assert.equal(claimErrorText(est(undefined, "simulation failed: AA23 reverted 0x1234abcd")), REJECTED);
  const rd = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Ownable: caller 0x12ab is not the owner"] });
  assert.equal(claimErrorText(est(rd)), REJECTED);
  assert.equal(claimErrorText(new Error("Nothing changed.")), "Nothing changed.");
});

test("verify / admin screens: plainText keeps API copy, rewords internals", () => {
  assert.equal(plainText("Log in with email or Google first."), "Log in with email or Google first.");
  assert.equal(plainText("Bad JSON"), "Bad JSON");
  assert.equal(plainText(`kv error at 0xdeadbeef: rpc timeout`), REJECTED);
});

test("UI call sites no longer render raw error text (static scan; GAME-owned files excluded)", () => {
  const files = ["components/profile/CashPanel.tsx", "components/WalletButton.tsx", "components/claims/VerifyRequest.tsx", "components/claims/AdminVerify.tsx", "app/create/page.tsx", "app/error.tsx"];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/console\.warn\([^;]*;/g, "");
    assert.doesNotMatch(src, /set\w+\([^)]*\(e(rr)? as Error\)\.message(?!\)?\s*,\s*")/, `${f} shows a raw message`);
    assert.doesNotMatch(src, /error\.message\.slice/, `${f} shows a raw message`);
    assert.doesNotMatch(src, /set(Launched|Msg|Err)\([^;]*\$\{(res\.token|fr)/, `${f} shows an address`);
  }
});

test("approved + pending strings are themselves plain", () => {
  for (const s of [REJECTED, PENDING, GRADUATED, CREATOR_BUY, QUOTE_REJECTED, "Launched. Assigning the fee receiver (one more confirmation)…", "Launched, but setting the fee receiver didn't go through. You can retry from the rocket page later."]) { plain(s); assert.ok(!JARGON.test(s), s); }
});

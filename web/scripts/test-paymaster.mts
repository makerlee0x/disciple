// F-01/F-02: disabled sponsorship/relay boundaries, no RPC, keys, signing, or transactions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { POST as paymaster } from "../app/api/paymaster/route";
import { POST as drip } from "../app/api/drip/route";
import { POST as bundler } from "../app/api/bundler/route";
import { selfBundle } from "../lib/server/selfBundler";
import { standardRelayer, sendUserOperationSync, warmRelay } from "../lib/server/fastRelay";
import { streamRelay } from "../lib/server/relayStream";
import { checkSelfPaid, checkPaymaster, checkOpGas, clientFees } from "../lib/aa/gasPolicy";
import { DEPLOYMENTS, robinhoodTestnet } from "../lib/chains";
import { Mav2Account, FEES } from "../lib/aa/mav2";
import { privateKeyToAccount } from "viem/accounts";
import type { UserOp } from "../lib/aa/core";

const PM = `0x${"22".repeat(20)}`, sender = `0x${"11".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`, txHash = `0x${"44".repeat(32)}`;
const op: UserOp = { sender: sender as never, nonce: "0x0", callData: "0x12345678", callGasLimit: "0x1b7740", verificationGasLimit: "0x55730", preVerificationGas: "0xea60", maxFeePerGas: "0x989680", maxPriorityFeePerGas: "0x10c8e0", signature: "0xdead" };
const request = (method: string, userOp: unknown = op) => new Request("http://localhost/api/bundler", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.19" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: [userOp] }) });
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Only this test process is configured; nothing changes app env files or deployed settings.
process.env.ALCHEMY_API_KEY = "unit-test-external-bundler";
process.env.AA_SELF_BUNDLER = "1";
process.env.AA_TRADE_SELF_RELAY = "1";
process.env.NEXT_PUBLIC_RHT_PAYMASTER = PM;

for (const [name, route] of [["paymaster", paymaster], ["drip", drip]] as const) {
  test(`${name} always rejects without fetching, signing, or parsing a body`, async () => {
    const old = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; throw Error("no I/O permitted"); };
    try { const r = await route(new Request("http://localhost", { method: "POST", body: "not-json" })); assert.equal(r.status, 410); assert.match(JSON.stringify(await r.json()), /gas sponsorship disabled/); assert.equal(calls, 0); }
    finally { globalThis.fetch = old; }
  });
}

test("all sponsorship representations are rejected even with an allowed address and unlimited deposit", () => {
  const variants = [{ paymaster: PM }, { paymasterAndData: `0x${"22".repeat(20)}` }, { paymasterData: "0xab" }, { paymasterVerificationGasLimit: "0x1" }, { paymasterPostOpGasLimit: "0x1" }];
  for (const p of variants) {
    assert.throws(() => checkSelfPaid(p), /temporarily unavailable/);
    assert.throws(() => checkPaymaster(p, PM, BigInt(10) ** BigInt(30), BigInt(0)), /temporarily unavailable/);
    assert.throws(() => checkOpGas({ ...op, ...p }, BigInt(0)), /temporarily unavailable/);
  }
  assert.doesNotThrow(() => checkSelfPaid({}));
  assert.doesNotThrow(() => checkSelfPaid({ paymasterAndData: "0x", paymasterData: "0x" }));
});

test("old relay flags cannot re-enable custom methods or sponsorship RPCs", async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("no I/O permitted"); };
  try {
    for (const method of ["disciple_sendUserOperationSync", "disciple_warm", "pm_getPaymasterData", "pm_getPaymasterStubData", "pm_getPaymasterAllowance", "alchemy_requestGasAndPaymasterAndData"]) {
      const r = await bundler(request(method)); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, -32601);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test("proxy rejects sponsored send/estimate before contacting the external bundler", async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("no I/O permitted"); };
  try {
    for (const method of ["eth_sendUserOperation", "eth_estimateUserOperationGas"]) {
      for (const pm of [{ paymaster: PM }, { paymasterAndData: "0xab" }, { paymasterData: "0xab" }, { paymasterPostOpGasLimit: "0x1" }]) {
        const r = await bundler(request(method, { ...op, ...pm })); assert.equal(r.status, 400); assert.match((await r.json()).error.message, /sponsorship disabled/);
      }
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test("self-paid op is forwarded unchanged even with AA_SELF_BUNDLER=1", async () => {
  const old = globalThis.fetch; const calls: { url: string; body: any }[] = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), body: JSON.parse(String(opts?.body)) }); return Response.json({ jsonrpc: "2.0", id: 7, result: hash }); };
  try {
    const r = await bundler(request("eth_sendUserOperation")); assert.equal(r.status, 200); assert.equal((await r.json()).result, hash);
    assert.equal(calls.length, 1); assert.match(calls[0].url, /^https:\/\/robinhood-testnet\.g\.alchemy\.com\/v2\//); assert.deepEqual(calls[0].body.params[0], op);
  } finally { globalThis.fetch = old; }
});

test("missing external bundler fails closed, with no protocol fallback", async () => {
  const key = process.env.ALCHEMY_API_KEY, pub = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY, old = globalThis.fetch; let calls = 0;
  delete process.env.ALCHEMY_API_KEY; delete process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  globalThis.fetch = async () => { calls++; throw Error("no fallback"); };
  try { const r = await bundler(request("eth_sendUserOperation")); assert.equal(r.status, 503); assert.match((await r.json()).error.message, /protocol relay disabled/); assert.equal(calls, 0); }
  finally { if (key !== undefined) process.env.ALCHEMY_API_KEY = key; if (pub !== undefined) process.env.NEXT_PUBLIC_ALCHEMY_API_KEY = pub; globalThis.fetch = old; }
});

test("external auth/network errors never trigger protocol relaying", async () => {
  const old = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("Must be authenticated!", { status: 401 }); };
    assert.equal((await bundler(request("eth_sendUserOperation"))).status, 401); assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw Error("network"); };
    assert.equal((await bundler(request("eth_sendUserOperation"))).status, 502); assert.equal(calls, 2);
  } finally { globalThis.fetch = old; }
});

test("stale internal relay entry points reject before any fetch/callback", async () => {
  const old = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("no I/O"); };
  try {
    await assert.rejects(selfBundle("eth_sendUserOperation", [op], { beforeSend: () => { calls++; } }), /relay disabled/);
    await assert.rejects(sendUserOperationSync(op, () => { calls++; }, async () => { calls++; }), /relay disabled/);
    await assert.rejects(standardRelayer(), /relay disabled/); await assert.rejects(warmRelay(sender), /relay disabled/);
    assert.equal(streamRelay([op], async () => { calls++; }).status, 410); assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test("funded warm one-tap still signs locally and uses only standard self-paid submission", async () => {
  const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: {} as never, bundlerUrl: "http://bundler.invalid" }, owner);
  let signed = 0; const requests: any[] = [];
  const client = { account: { address: sender, encodeExecute: async () => op.callData }, buildUserOperation: async ({ overrides }: any) => ({ ...op, ...overrides }), signUserOperation: async ({ uoStruct }: any) => { signed++; return uoStruct; } };
  (a as any).sessionClient = { entityId: 1, c: Promise.resolve(client) }; a.deployed = true;
  (a as any).findOp = async () => ({ userOpHash: hash, txHash, success: true, logs: [] });
  FEES.invalidate(); await FEES.get(async () => clientFees(BigInt(1)));
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => { requests.push(JSON.parse(String(opts?.body))); return Response.json({ result: hash }); };
  try {
    const r = await a.sendCalls([{ to: sender as never, data: "0x12345678" }], "session");
    assert.equal(signed, 1); assert.equal(requests.length, 1); assert.equal(requests[0].method, "eth_sendUserOperation");
    assert.equal(requests[0].params[0].paymaster, undefined); assert.equal(requests[0].params[0].paymasterAndData, undefined); assert.equal(r.gasMode, "self-pay");
    assert.equal(a.gasReservePerOp(), BigInt(0)); assert.equal(a.peekGasReservePerOp("gradBuy"), BigInt(0));
  } finally { globalThis.fetch = old; FEES.invalidate(); }
});

test("ETH-less bootstrap surfaces prefund failure without drip or sponsorship requests", async () => {
  const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const a = new Mav2Account({ chain: robinhoodTestnet, pc: { getBalance: async () => BigInt(0) } as never, bundlerUrl: "http://bundler.invalid" }, owner);
  (a as any).sessionClient = { entityId: 1, c: Promise.resolve({ account: { address: sender }, buildUserOperation: async () => { throw Error("AA21 didn't pay prefund"); } }) }; a.deployed = true;
  FEES.invalidate(); await FEES.get(async () => clientFees(BigInt(1)));
  const old = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw Error("no sponsorship"); };
  try { await assert.rejects(a.sendCalls([{ to: sender as never, data: "0x12345678" }], "session"), (e: any) => e.code === "FundAccount"); assert.equal(calls, 0); }
  finally { globalThis.fetch = old; FEES.invalidate(); }
});

test("no deployed chain config, quote signer, keeper, or browser fallback can enable sponsorship", () => {
  for (const d of Object.values(DEPLOYMENTS)) assert.match(d.paymaster, /^0x0{40}$/i);
  for (const f of ["lib/aa/paymaster.ts", "lib/aa/paymasterClient.ts", "lib/server/paymasterCore.ts", "lib/server/paymasterQuote.ts", "lib/server/paymasterDeposit.ts", "scripts/paymaster-keeper.mts"]) assert.equal(existsSync(new URL(`../${f}`, import.meta.url)), false, f);
  assert.doesNotMatch(src("lib/aa/mav2.ts"), /payGasInUsdg|relaySend\(|relaySync\(|pm_get|usdgGas/);
  assert.doesNotMatch(src("lib/aa/session.ts"), /fetch\("\/api\/drip|refillGas|dripOnce|disciple_warm|usdgGas/);
  assert.doesNotMatch(src("app/api/bundler/route.ts"), /selfBundle|fastRelay|streamRelay|RELAYER_PRIVATE_KEY|DRIP_FAUCET_KEY/);
  assert.match(src("../contracts/script/DeployPaymaster.s.sol"), /revert\("gas sponsorship disabled"\)/);
  assert.doesNotMatch(src("../contracts/script/DeployPaymaster.s.sol"), /startBroadcast|new DisciplePaymaster|addStake|\.deposit/);
});

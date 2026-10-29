// Data retest (Oct 23) #1: after a relay/broadcast error the op id must be KEPT, RETURNED and SHOWN — never lost and
// never another op's id. Drives the real client (lib/aa/mav2 fast path) → the real /api/bundler route (self-bundler,
// AA_SELF_BUNDLER=1) → lib/server/fastRelay, with the chain RPC mocked in-process (global fetch).
//   pnpm test:relay-op   (no live endpoint, throwaway keys, nothing broadcast)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toEventSelector, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.AA_SELF_BUNDLER = "1";
process.env.RELAYER_LOCAL_TEST = "1";
process.env.RELAYER_PRIVATE_KEY = generatePrivateKey();   // throwaway, never funded
delete process.env.ALCHEMY_API_KEY; delete process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;

const BASE = BigInt(10_000_000);
type Mode = "timeout" | "reverted" | "landed-late";
let mode: Mode = "timeout";
const raws: Hex[] = [];
let landed: { hash: Hex; txHash: Hex } | null = null;
const rpc = (method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_chainId": return "0xb626";
    case "eth_getBlockByNumber": return { number: "0x64", hash: "0x" + "aa".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: "0x1", baseFeePerGas: "0x" + BASE.toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [], logsBloom: "0x" + "00".repeat(256), miner: "0x" + "00".repeat(20), difficulty: "0x0", extraData: "0x", nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), size: "0x1" };
    case "eth_blockNumber": return "0x64";
    case "eth_call": return "0x";
    case "eth_getTransactionCount": return "0x0";
    case "eth_getBalance": return "0xde0b6b3a7640000";
    case "eth_sendRawTransactionSync": {
      const raw = params[0] as Hex; raws.push(raw);
      if (mode === "reverted") return { status: "0x0", transactionHash: keccak256(raw), logs: [] };
      // EIP-7966: accepted into the pool but not mined in time ⇒ the op may still land
      throw Object.assign(new Error("transaction added to the pool but not processed within timeout"), { rpc: { code: 4, message: "The transaction was added to the transaction pool but wasn't processed in 2000ms" } });
    }
    default: throw Object.assign(new Error(`unmocked ${method}`), { rpc: { code: -32601, message: `method ${method} not found` } });
  }
};
const realFetch = globalThis.fetch;
let routePOST: (req: Request) => Promise<Response>;
/** when set, answers the client's /api/bundler call instead of the real route (network failure, unreadable body, …) */
let bundlerOverride: ((body: { params: [Record<string, unknown>] }) => Promise<Response>) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/bundler") && bundlerOverride) return bundlerOverride(JSON.parse(String(init?.body)));
  if (url.includes("/api/bundler")) return routePOST(new Request(url, { method: "POST", body: init?.body as string, headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" } }));
  const body = JSON.parse(String(init?.body));
  const one = (b: { id: number; method: string; params: unknown[] }) => {
    try { return { jsonrpc: "2.0", id: b.id, result: rpc(b.method, b.params) }; }
    catch (e) { return { jsonrpc: "2.0", id: b.id, error: (e as { rpc?: unknown }).rpc ?? { code: -32000, message: (e as Error).message } }; }
  };
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { POST } = await import("../app/api/bundler/route");
routePOST = POST as never;
const { Mav2Account, FEES } = await import("../lib/aa/mav2");
const { userOpHash } = await import("../lib/aa/core");
const { clientFees } = await import("../lib/aa/gasPolicy");
const { STATIC_GAS } = await import("../lib/aa/fastPath");
const { robinhoodTestnet } = await import("../lib/chains");
const { ENTRYPOINT_V07 } = await import("../lib/aa/constants");
const { relayOpRef, keptOpRef } = await import("../lib/aa/relayOp");
// approved by lee 2026-10-24 — asserted verbatim (not imported) so a copy change has to touch this test too
const PENDING = "Still confirming. Check back in a moment.";
const REJECTED = "That didn't go through. Try again.";
/** player-visible text must carry no ids and no chain/relay jargon */
const plain = (m: string, ids: (string | undefined)[]) => {
  for (const id of ids) if (id) { assert.ok(!m.toLowerCase().includes(id.toLowerCase()), `id leaked: ${m}`); assert.ok(!m.includes(`${id.slice(0, 6)}…`), `short id leaked: ${m}`); }
  assert.doesNotMatch(m, /0x[0-9a-f]{4}|\bop\b|userop|\btx\b|relay|on-?chain|bundle|simulation/i);
};
/** console.warn capture: the ids go to the console log instead */
const warned: unknown[][] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a); };
const { friendlyError } = await import("../lib/protocol-viem");

const SENDER = privateKeyToAccount(generatePrivateKey()).address;
const hex = (n: bigint) => "0x" + n.toString(16) as Hex;
const callData = encodeFunctionData({ abi: parseAbi(["function execute(address,uint256,bytes)"]), functionName: "execute", args: ["0x0000000000000000000000000000000000000001", BigInt(0), "0x"] });
let built: Record<string, unknown> | null = null;
const fakeClient = {
  account: { address: SENDER, getEntryPoint: () => ({ address: ENTRYPOINT_V07 }) },
  async buildUserOperation({ overrides }: { overrides: Record<string, bigint> }) {
    built = { sender: SENDER, nonce: overrides.nonce, callData, callGasLimit: overrides.callGasLimit, verificationGasLimit: overrides.verificationGasLimit, preVerificationGas: overrides.preVerificationGas, maxFeePerGas: overrides.maxFeePerGas, maxPriorityFeePerGas: overrides.maxPriorityFeePerGas, signature: "0x" };
    return built;
  },
  async signUserOperation({ uoStruct }: { uoStruct: Record<string, unknown> }) { return { ...uoStruct, signature: ("0x" + "11".repeat(65)) as Hex }; },
};
const uoTopic = toEventSelector("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const fakePc = {
  getBlockNumber: async () => BigInt(100),
  getBalance: async () => BigInt(10) ** BigInt(18),
  async getLogs({ args }: { args: { userOpHash: Hex } }) {
    if (!landed || landed.hash !== args.userOpHash) return [];
    return [{ transactionHash: landed.txHash, args: { userOpHash: landed.hash, success: true } }];
  },
  async getTransactionReceipt({ hash }: { hash: Hex }) {
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [BigInt(0), true, BigInt(1), BigInt(1)]);
    return { transactionHash: hash, logs: [{ address: ENTRYPOINT_V07, data, topics: [uoTopic, landed!.hash, ("0x" + "00".repeat(12) + SENDER.slice(2).toLowerCase()) as Hex, ("0x" + "00".repeat(32)) as Hex] }] };
  },
};
await FEES.get(async () => clientFees(BASE));
const account = () => {
  const sa = new Mav2Account({ chain: robinhoodTestnet, pc: fakePc as never, bundlerUrl: "http://relay.test/api/bundler" }, privateKeyToAccount(generatePrivateKey()));
  (sa as unknown as { ownerClient: Promise<unknown> }).ownerClient = Promise.resolve(fakeClient);
  sa.deployed = true;
  return sa;
};
const expectedHash = () => userOpHash({ ...(JSON.parse(JSON.stringify(built, (_k, v) => typeof v === "bigint" ? hex(v) : v))), signature: "0x" } as never, robinhoodTestnet.id);
const send = () => account().sendCalls([{ to: "0x0000000000000000000000000000000000000001", data: "0x" }]);

test("server: post-broadcast timeout answers with THIS op's userOpHash + the bundle tx hash (error.data)", async () => {
  mode = "timeout"; raws.length = 0;
  const op = { sender: SENDER, nonce: "0x1", callData, callGasLimit: hex(STATIC_GAS.callGasLimit), verificationGasLimit: hex(STATIC_GAS.verificationGasLimit), preVerificationGas: hex(STATIC_GAS.preVerificationGas), maxFeePerGas: hex(clientFees(BASE).maxFeePerGas * BigInt(2)), maxPriorityFeePerGas: hex(clientFees(BASE).maxPriorityFeePerGas), signature: ("0x" + "11".repeat(65)) as Hex };
  const res = await POST(new Request("http://relay.test/api/bundler", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.2" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "disciple_sendUserOperationSync", params: [op, ENTRYPOINT_V07] }) }));
  const j = await res.json() as { error: { message: string; data: { userOpHash: Hex; txHash: Hex; broadcast: boolean } } };
  assert.equal(raws.length, 1, "exactly one bundle tx sent");
  assert.equal(j.error.data.userOpHash, userOpHash(op as never, robinhoodTestnet.id));
  assert.equal(j.error.data.txHash, keccak256(raws[0]));
  assert.equal(j.error.data.broadcast, true);
  assert.match(j.error.message, new RegExp(`\\[userOp ${j.error.data.userOpHash}\\]`));
  assert.deepEqual(relayOpRef(j.error), { userOpHash: j.error.data.userOpHash, txHash: j.error.data.txHash, broadcast: true });
});

test("client: sent-but-unconfirmed op keeps its own id (Timeout) — player sees only the approved pending line, ids go to the console", async () => {
  mode = "timeout"; landed = null; warned.length = 0;
  const e = await send().then(() => assert.fail("should throw"), (x) => x as { code: string; message: string; extra: { userOpHash: Hex; txHash?: Hex } });
  const h = expectedHash();
  assert.equal(e.code, "Timeout");
  assert.equal(e.extra.userOpHash, h);
  assert.equal(e.extra.txHash, keccak256(raws[raws.length - 1]));
  assert.equal(e.message, PENDING);
  const pe = friendlyError(e);
  assert.equal(pe.message, PENDING);
  plain(pe.message, [h, e.extra.txHash]);
  assert.ok(`✕ ${pe.message}`.length <= 92, "fits the trade bar status (90 chars)");
  const log = warned.find((w) => String(w[0]).includes("pending"));
  assert.ok(log, "ids logged to the console");
  assert.deepEqual(log![1], { userOpHash: h, txHash: e.extra.txHash });
});

test("client: op that landed after the relay timed out resolves to a success with the SAME id", async () => {
  mode = "landed-late";
  // the relay times out; the op is on-chain by the time the client looks it up
  const prev = fakePc.getLogs;
  fakePc.getLogs = async (a) => { landed = { hash: expectedHash(), txHash: keccak256(raws[raws.length - 1]) }; return prev(a); };
  try {
    const r = await send();
    assert.equal(r.userOpHash, expectedHash());
    assert.equal(r.txHash, keccak256(raws[raws.length - 1]));
  } finally { fakePc.getLogs = prev; landed = null; }
});

test("client: reverted bundle → the approved 'didn't go through' line, ids kept on extra + console only", async () => {
  mode = "reverted"; warned.length = 0;
  const e = await send().then(() => assert.fail("should throw"), (x) => x as { code: string; message: string; extra: { userOpHash: Hex; txHash?: Hex } });
  assert.equal(e.code, "Reverted");
  assert.equal(e.extra.userOpHash, expectedHash());
  assert.equal(e.extra.txHash, keccak256(raws[raws.length - 1]));
  assert.equal(e.message, REJECTED);
  assert.equal(friendlyError(e).message, REJECTED);
  plain(friendlyError(e).message, [expectedHash(), e.extra.txHash]);
  const log = warned.find((w) => String(w[0]).includes("rejected"));
  assert.ok(log, "ids logged to the console");
  assert.deepEqual(log![1], { userOpHash: expectedHash(), txHash: e.extra.txHash });
});

test("a relay id for a DIFFERENT op is never kept (stale / wrong id dropped)", () => {
  const mine = ("0x" + "ab".repeat(32)) as Hex, other = ("0x" + "cd".repeat(32)) as Hex, tx = ("0x" + "ef".repeat(32)) as Hex;
  assert.deepEqual(keptOpRef(mine, { userOpHash: other, txHash: tx, broadcast: true }), { userOpHash: mine });
  assert.deepEqual(keptOpRef(mine, { userOpHash: mine, txHash: tx, broadcast: true }), { userOpHash: mine, txHash: tx });
  assert.deepEqual(keptOpRef(undefined, { userOpHash: other, txHash: tx, broadcast: true }), { userOpHash: other, txHash: tx });
  // message-only transports (viem RpcRequestError.details) still carry the id
  assert.equal(relayOpRef({ details: `eth_sendUserOperation: relayer tx ${tx} not confirmed (timeout) [userOp ${mine}]` })?.userOpHash, mine);
  assert.equal(relayOpRef({ message: "simulation failed: execution reverted" }), undefined);
});

const NO_PRICE = "Couldn't get a price right now. Try again.";
const { encodeErrorResult } = await import("viem");
const { AAError } = await import("../lib/aa/core");
const errOf = (p: Promise<unknown>) => p.then(() => assert.fail("should throw"), (x) => x as { code: string; message: string; extra: Record<string, unknown> });

test("client: op executed but reverted (no readable reason) → plain 'didn't go through', tx hash / ids only on extra + console", async () => {
  warned.length = 0;
  const tx = ("0x" + "9a".repeat(32)) as Hex;
  bundlerOverride = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userOpHash: expectedHash(), txHash: tx, success: false, logs: [] } }), { status: 200 });
  try {
    const e = await errOf(send());
    assert.equal(e.code, "Reverted");
    assert.equal(e.extra.txHash, tx);
    assert.equal(e.extra.userOpHash, expectedHash());
    assert.equal(e.message, REJECTED);
    assert.equal(friendlyError(e).message, REJECTED);
    plain(friendlyError(e).message, [tx, expectedHash()]);
    const log = warned.find((w) => String(w[0]) === "[disciple] trade reverted");
    assert.ok(log, "logged"); assert.equal((log![1] as { txHash: Hex }).txHash, tx);
  } finally { bundlerOverride = null; }
});

test("client: network failure before the relay answers → AUDIT L2 (#145): outcome unknown ⇒ Timeout + the plain pending line (never 'didn't go through'), raw text to console only", async () => {
  warned.length = 0;
  bundlerOverride = async () => { throw new TypeError("fetch failed: getaddrinfo ENOTFOUND relay.test"); };
  try {
    const e = await errOf(send());
    assert.equal(e.code, "Timeout");
    assert.equal(e.message, PENDING);
    assert.equal(friendlyError(e).message, PENDING);
    plain(friendlyError(e).message, [expectedHash()]);
    assert.match(String(e.extra.relayError), /^network: /, "raw detail kept on extra");
    assert.ok(warned.some((w) => String(w[0]).startsWith("[disciple] ") && /network: /.test(JSON.stringify(w[1]))), "raw text logged");
  } finally { bundlerOverride = null; }
});

test("client: unreadable relay response → AUDIT L2 (#145): outcome unknown ⇒ Timeout + the plain pending line, HTTP detail to console only", async () => {
  warned.length = 0;
  bundlerOverride = async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  try {
    const e = await errOf(send());
    assert.equal(e.code, "Timeout");
    assert.equal(e.message, PENDING);
    assert.equal(friendlyError(e).message, PENDING);
    plain(friendlyError(e).message, [expectedHash()]);
    assert.match(String(e.extra.relayError), /unreadable \(HTTP 502\)/);
    assert.ok(warned.some((w) => String(w[0]).startsWith("[disciple] ") && /HTTP 502/.test(JSON.stringify(w[1]))), "HTTP detail logged");
  } finally { bundlerOverride = null; }
});

test("price/quote failure (QuoteFailed, also wrapped in PreExecHookReverted) → 'Couldn't get a price right now. Try again.'", () => {
  warned.length = 0;
  const target = "0x00000000000000000000000000000000000000aa";
  const inner = encodeErrorResult({ abi: parseAbi(["error QuoteFailed(address target)"]), errorName: "QuoteFailed", args: [target] });
  const outer = encodeErrorResult({ abi: parseAbi(["error PreExecHookReverted(bytes24 moduleFunction, bytes revertReason)"]), errorName: "PreExecHookReverted", args: [`0x${"11".repeat(24)}`, inner] });
  for (const raw of [inner, outer]) for (const code of ["Estimate", "Reverted"] as const) {
    const pe = friendlyError(new AAError(code, "x", { revertData: raw }));
    assert.equal(pe.code, "QuoteFailed");
    assert.equal(pe.message, NO_PRICE);
    plain(pe.message, [target]);
  }
  assert.ok(warned.some((w) => String(w[0]) === "[disciple] quote failed"), "target logged");
});

test("unknown revert selector on a Reverted op stays out of the copy (console only)", () => {
  warned.length = 0;
  const pe = friendlyError(new AAError("Reverted", REJECTED, { revertData: "0xcafebabe", txHash: "0x" + "12".repeat(32) }));
  assert.equal(pe.message, REJECTED);
  plain(pe.message, ["0xcafebabe"]);
  assert.ok(warned.some((w) => /cafebabe/.test(JSON.stringify(w[1]))), "selector logged");
});

test("pre-send check failed (simulation) with an unknown revert payload → plain line, selector + raw text to console only", () => {
  warned.length = 0;
  const e = new AAError("Estimate", "simulation failed: execution reverted (0xdeadbeef)", { revertData: "0xdeadbeef00" });
  const pe = friendlyError(e);
  assert.equal(pe.code, "Estimate");
  assert.equal(pe.message, REJECTED);
  plain(pe.message, ["0xdeadbeef"]);
  assert.equal(e.message, "simulation failed: execution reverted (0xdeadbeef)", "AAError message kept (session/transient retry logic reads it)");
  assert.equal(e.extra?.revertData, "0xdeadbeef00", "attached data kept");
  const log = warned.find((w) => String(w[0]) === "[disciple] trade pre-check failed");
  assert.ok(log, "logged"); assert.equal((log![1] as { selector: string }).selector, "0xdeadbeef");
});

test("pre-send check failed (simulation) with NO revert data → plain line, raw text to console only", () => {
  warned.length = 0;
  const e = new AAError("Estimate", "simulation failed: AA23 reverted: 0x1234abcd relayer tx userOp", {});
  const pe = friendlyError(e);
  assert.equal(pe.code, "Estimate");
  assert.equal(pe.message, REJECTED);
  plain(pe.message, ["0x1234abcd"]);
  assert.ok(warned.some((w) => String(w[0]) === "[disciple] trade pre-check failed" && /AA23 reverted/.test(JSON.stringify(w[1]))), "raw text logged");
  // same for a raw (non-AAError) pre-send error that reaches friendlyError
  for (const raw of ["simulation failed: execution reverted", "execution reverted in simulation (0xdeadbeef): boom"]) {
    const p2 = friendlyError(new Error(raw));
    assert.equal(p2.message, REJECTED); plain(p2.message, ["0xdeadbeef"]);
  }
});

test("pre-send failures that already map to a specific message keep it (balance, slippage, wallet cap)", () => {
  const E2 = parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)", "error MinOutTooLow(uint256 minOut, uint256 required)", "error WalletCap()", "error PreExecHookReverted(bytes24 moduleFunction, bytes revertReason)"]);
  const bal = encodeErrorResult({ abi: E2, errorName: "ERC20InsufficientBalance", args: ["0x0000000000000000000000000000000000000001", BigInt(0), BigInt(1)] });
  const mo = encodeErrorResult({ abi: E2, errorName: "MinOutTooLow", args: [BigInt(1), BigInt(2)] });
  const wrapped = encodeErrorResult({ abi: E2, errorName: "PreExecHookReverted", args: [`0x${"11".repeat(24)}`, mo] });
  const cases: [Hex, string][] = [
    [bal, "Not enough balance for that shot size — deposit more or pick a smaller ammo."],
    [mo, "Price moved past your one-tap max slippage. Try again or raise slippage."],
    [wrapped, "Price moved past your one-tap max slippage. Try again or raise slippage."],
  ];
  cases.push([encodeErrorResult({ abi: E2, errorName: "WalletCap" }), "Wallet cap reached: one wallet can hold at most 7% before orbit."]);
  cases.push([encodeErrorResult({ abi: parseAbi(["error Slippage()"]), errorName: "Slippage" }), "Price moved too much. Try again or raise slippage."]);
  for (const [rd, want] of cases) {
    const pe = friendlyError(new AAError("Estimate", "simulation failed: execution reverted", { revertData: rd }));
    assert.equal(pe.message, want);
    assert.doesNotMatch(pe.message, /simulation|0x/);
  }
});

test.after(() => { globalThis.fetch = realFetch; console.warn = realWarn; });

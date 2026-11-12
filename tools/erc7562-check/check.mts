/**
 * ERC-7562 admission check for DisciplePaymaster v5 on a LOCAL anvil fork. No source checkout changes.
 *
 * Tool: eth-infinitism/bundler BundlerCollectorTracer (JS) + tracerResultParser,
 * commit aae77140e5c2b1386d04eaeba2d23fc17a62bd87. Anvil has no native
 * `erc7562Tracer`, which Rundler v0.11 safe mode requires, so this is the reference
 * bundler's JavaScript tracer path (debug_traceCall) plus that parser's rule audit.
 * An explicit EREP-050 check is applied on top: the legacy parser does not cover it.
 *
 * No live-network broadcast. Player keys are generated here. The anvil dev key is
 * used only to deploy and stake on the local fork.
 *
 * Run with bash run.sh after bash setup.sh /path/to/disciple/contracts.
 * Uses unmodified reference rule engines via documented runtime/trace adapters; not an Alchemy API verdict.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { LocalAccountSigner } from "@aa-sdk/core";
import { buildCreateSession, Perm, TRADE_PERMS } from "./site/sdk/session-keys/src/index";
import {
  concat, createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, defineChain, encodeAbiParameters, encodeDeployData,
  encodeFunctionData, http, parseAbi, parseAbiItem, toFunctionSelector, toHex, zeroAddress,
  type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { MAV2_FACTORY, ENTRYPOINT_V07 } from "./site/web/lib/aa/constants";
import {
  PAYMASTER_GAS, encodePaymasterData, entryPointMaxCost, paymasterLaunchQuoteHash, paymasterQuoteHash, paymasterAllowanceHash,
  requiredMaxTokenCost, tokenCost, type PaymasterQuote,
} from "./site/web/lib/aa/paymaster";
import { SETUP_DEPOSIT, SEND_CREDIT_LOCK, setupCreditCalls, usdgSendCalls, withAutoTopUp } from "./site/web/lib/aa/prepayBootstrap";
import type { Call, UserOp } from "./site/web/lib/aa/core";

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:18545";
const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const LIVE_STAKE = 2173913043478261n;
const UNSTAKE_DELAY = 86400;
const RATE = 2_300_000_000n;
const USDG = "0x9dC7A988a8707dC4AB7ac08fC2CB4D5bf906158D" as Address;
const ROUTER = "0x688160633b22012717661545df6299d3d3174ad2" as Address;
const LAUNCHPAD = "0x8a92e51940909424b3aacefff99b4834588c0988" as Address;
const COIN = "0xc7E64e22c58c16926f99D0c12A31187364B369F5" as Address;
const TRAMP = "0xe9e98e149b43ff20dc7db665eefc387a8926e618" as Address;
const SINGLE = "0x00000000000099DE0BF6fA90dEB851E2A2df7d83" as Address;
const TIME_RANGE = "0x00000000000082B8e2012be914dFA4f62A0573eA" as Address;
const ENTITY = 8;
const salt = BigInt(Date.now());
const EXECUTE_USER_OP = "0x8dd7712f" as Hex;

if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(RPC).hostname)) throw new Error("LOCAL ANVIL ONLY");
const chain = defineChain({
  id: 46630, name: "RH testnet fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pc = createPublicClient({ chain, transport: http(RPC) });
const anvil = privateKeyToAccount(ANVIL_PK);
const wallet = createWalletClient({ account: anvil, chain, transport: http(RPC) });

const epAbi = parseAbi([
  "function getDepositInfo(address) view returns (uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime)",
  "function addStake(uint32 unstakeDelaySec) payable",
  "function depositTo(address) payable",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const factoryAbi = parseAbi([
  "function getAddressSemiModular(address owner, uint256 salt) view returns (address)",
  "function createSemiModularAccount(address owner, uint256 salt) returns (address)",
]);
const erc20 = parseAbi([
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const pmAbi = parseAbi([
  "function creditOf(address) view returns (uint256)",
  "function reservedOf(address) view returns (uint256)",
  "function deposit(address,uint256)",
  "function setLaunchGasLimit(uint256)",
  "error QuoteWindowInvalid()",
  "error InsufficientCredit(uint256 available, uint256 required)",
  "error MaxCostTooLow(uint256 maxTokenCost, uint256 required)",
  "error GasLimitAboveCap(uint256 gasUnits, uint256 cap)",
  "error BadCreditCall()",
  "error Pending()",
]);
const execAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls)",
  "function execute(address target, uint256 value, bytes data)",
]);
const routerAbi = parseAbi([
  "function quoteUsdgRouteFor(address trader, address token, bool isBuy, uint256 amountIn) returns (uint256 amountOut, uint256 maxHopImpactBps)",
  "function buyWithUsdg(address token, uint256 usdgIn, uint256 minTokensOut, uint256 deadline)",
  "function sellToUsdg(address token, uint256 tokensIn, uint256 minUsdgOut, uint256 deadline)",
]);
const launchAbi = parseAbi([
  "function launchWithMode((string name,string ticker,string imageURI,string description,string socialsURI,address quote,uint256 creatorTaxBps,uint256 creatorBuyQuoteIn,uint256 creatorBuyMinTokensOut,uint256 deadline,uint8 creatorFeeDestination) params, uint8 mode)",
]);
const VALIDATE_USER_OP = toFunctionSelector("validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)");
const VALIDATE_PM = toFunctionSelector("validatePaymasterUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)");
const POST_OP = toFunctionSelector("postOp(uint8,bytes,uint256,uint256)");

const require = createRequire(import.meta.url);
const { tracerResultParser } = require("./validator/TracerResultParser.cjs") as {
  tracerResultParser: (op: Record<string, string>, tracer: unknown, validation: unknown, ep: string) => [string[], unknown];
};
const { ERC7562Parser } = require("./validator/ERC7562Parser.cjs");
const { normalize } = require("./validator/normalize.cjs");
const TRACER = readFileSync(new URL("./validator/tracer.js", import.meta.url), "utf8");

type Limits = { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };
const TRADE_LIMITS: Limits = { callGasLimit: 1_800_000n, verificationGasLimit: 350_000n, preVerificationGas: 60_000n };
const SETUP_LIMITS: Limits = { callGasLimit: 1_200_000n, verificationGasLimit: 900_000n, preVerificationGas: 80_000n };
const LAUNCH_LIMITS: Limits = { callGasLimit: 14_000_000n, verificationGasLimit: 500_000n, preVerificationGas: 80_000n };

const artifact = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { bytecode: { object: Hex }; abi: unknown };
const pmArt = artifact(new URL("./artifacts/DisciplePaymasterV5.sol/DisciplePaymasterV5.json", import.meta.url).pathname);
const polArt = artifact(new URL("./artifacts/DiscipleSessionPolicyV143.sol/DiscipleSessionPolicyV143.json", import.meta.url).pathname);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json() as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

function batch(calls: Call[], session: boolean): Hex {
  const inner = encodeFunctionData({
    abi: execAbi, functionName: "executeBatch",
    args: [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data }))],
  });
  return session ? concat([EXECUTE_USER_OP, inner]) : inner;
}

class Nonces {
  private n = 0n;
  private prefix = BigInt(`0x${generatePrivateKey().slice(2, 24)}`);
  /** Same layout as web/lib/aa/fastPath NonceCursor: owner is global entity 0, session is non-global. */
  next(entityId: number, isGlobal: boolean): bigint {
    this.n += 1n;
    const key = ((this.prefix << 64n) | this.n) & ((1n << 152n) - 1n);
    return ((key << 40n) + (BigInt(entityId) << 8n) + (isGlobal ? 1n : 0n)) << 64n;
  }
}

async function send(data: Hex, to?: Address, value?: bigint) {
  const hash = await wallet.sendTransaction({ to, data, value: value ?? 0n });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx reverted ${hash}`);
  return rc;
}

async function stakeOf(addr: Address) {
  const [deposit, staked, stake, delay] = await pc.readContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "getDepositInfo", args: [addr] });
  return { deposit, staked, stake, delay };
}

function packedOp(op: UserOp) {
  const initCode = op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x";
  const paymasterAndData = op.paymaster
    ? concat([
      op.paymaster,
      toHex(BigInt(op.paymasterVerificationGasLimit!), { size: 16 }),
      toHex(BigInt(op.paymasterPostOpGasLimit!), { size: 16 }),
      op.paymasterData ?? "0x",
    ])
    : "0x";
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode,
    callData: op.callData,
    accountGasLimits: concat([toHex(BigInt(op.verificationGasLimit!), { size: 16 }), toHex(BigInt(op.callGasLimit!), { size: 16 })]),
    preVerificationGas: BigInt(op.preVerificationGas!),
    gasFees: concat([toHex(BigInt(op.maxPriorityFeePerGas!), { size: 16 }), toHex(BigInt(op.maxFeePerGas!), { size: 16 })]),
    paymasterAndData,
    signature: op.signature,
  };
}
function handleOpsData(op: UserOp): Hex {
  return encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[packedOp(op)], anvil.address] });
}

function decodeRevert(data?: string): string {
  if (!data || data === "0x") return "revert with no data";
  for (const abi of [epAbi, pmAbi]) {
    try { const d = decodeErrorResult({ abi, data: data as Hex }); return `${d.errorName}(${d.args.map(String).join(",")})`; } catch { /* next */ }
  }
  return data.slice(0, 120);
}

type Verdict = {
  name: string; admitted: boolean; rule?: string; detail: string; dependsOnStake: boolean; unstakedRule?: string;
  validationGas?: string; executionGas?: string; postOpGas?: string; totalGas?: string;
  usdgCharged?: string; actualGasUsed?: string; executionSuccess?: boolean; maxFeePerGas: string;
};

async function traceRules(name: string, op: UserOp, paymaster: Address): Promise<Verdict> {
  const fee = op.maxFeePerGas!;
  const data = handleOpsData(op);
  const gas = toHex(8_000_000n + BigInt(op.callGasLimit!) + BigInt(op.verificationGasLimit!));
  const traced = await rpc<any>("debug_traceCall", [{ from: anvil.address, to: ENTRYPOINT_V07, data, gas }, "latest", { tracer: TRACER }]);
  const calls = (traced.calls ?? []) as { type: string; data?: string }[];
  writeFileSync(new URL(`./traces/${name[0]}-collector.json`, import.meta.url), JSON.stringify(traced, null, 2));
  writeFileSync(new URL(`./traces/${name[0]}-op.json`, import.meta.url), JSON.stringify(op, null, 2));
  const revert = !traced.logs?.some((l: any) => l.topics?.[0]?.toLowerCase() === "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972") ? calls[calls.length-1] : undefined;
  const revertText = revert?.type === "REVERT" ? decodeRevert(revert.data) : "";
  const info = async (addr: Address) => {
    const s = await stakeOf(addr);
    return { addr, stake: s.stake.toString(), unstakeDelaySec: Number(s.delay) };
  };
  const validation: Record<string, unknown> = { senderInfo: await info(op.sender), paymasterInfo: await info(paymaster) };
  const parserOp: Record<string, string> = { sender: op.sender, paymaster };
  if (op.factory) {
    parserOp.factory = op.factory;
    validation.factoryInfo = await info(op.factory);
  }
  const normalized = normalize(traced, ENTRYPOINT_V07);
  (validation.paymasterInfo as any).context = normalized.context;
  writeFileSync(new URL(`./traces/${name[0]}-normalized.json`, import.meta.url), JSON.stringify(normalized, null, 2));
  const parser = new ERC7562Parser(ENTRYPOINT_V07, normalized.senderCreator);
  const nativeResults = parser.parseResults(parserOp, normalized.root, validation);
  const unstakedValidation = {...validation,paymasterInfo:{addr:paymaster,stake:"0",unstakeDelaySec:0,context:normalized.context}};
  const saveError = console.error; console.error = () => {};
  let unstakedResults: any;
  try { unstakedResults = parser.parseResults(parserOp, normalized.root, unstakedValidation); } finally { console.error = saveError; }
  writeFileSync(new URL(`./traces/${name[0]}-rules.json`, import.meta.url), JSON.stringify({staked:nativeResults,unstaked:unstakedResults}, null, 2));
  let rule = "";
  let detail = "validation trace completed";
  let admitted = true;
  try {
    tracerResultParser(parserOp, traced, validation, ENTRYPOINT_V07);
  } catch (e) {
    const err = e as { message?: string; code?: number };
    admitted = false;
    rule = err.code === -32502 ? "OP/STO (OpcodeValidation -32502)" : `code ${err.code ?? "?"}`;
    detail = err.message ?? String(e);
  }
  if (nativeResults.ruleViolations.length) { admitted = false; rule = nativeResults.ruleViolations.map((r:any)=>r.rule).join(","); detail = nativeResults.ruleViolations.map((r:any)=>r.description).join(" | "); }
  if (admitted && revertText) {
    admitted = false;
    rule = rule || "validation reverted";
    detail = revertText;
  }
  let unstakedRule: string | undefined;
  try {
    const unstaked = {
      ...validation,
      paymasterInfo: { addr: paymaster, stake: "0", unstakeDelaySec: 0 },
    };
    tracerResultParser(parserOp, traced, unstaked, ENTRYPOINT_V07);
  } catch (e) {
    unstakedRule = (e as { message?: string }).message ?? String(e);
  }
  // EREP-050 is enforced by the native-tracer parser, not tracerResultParser. A non-empty paymaster
  // context is the ABI return of validatePaymasterUserOp; an unstaked paymaster must not return one.
  const pmStake = await stakeOf(paymaster);
  const staked = pmStake.staked && pmStake.stake >= 1n && pmStake.delay >= 1;
  const contextReturn = calls.some((c) => c.type === "RETURN" && (c.data?.length ?? 0) > 200);
  if (!staked && contextReturn && admitted) {
    admitted = false;
    rule = "EREP-050";
    detail = "unstaked paymaster returned a context";
  }
  const dependsOnStake = unstakedRule !== undefined || unstakedResults.ruleViolations.length > 0 || !staked || rule === "EREP-050";
  return { name, admitted, rule: rule || undefined, detail, dependsOnStake, unstakedRule, maxFeePerGas: fee };
}

function gasFromTree(op: UserOp, tree: any) {
  const top: any[] = [];
  const flatten = (n:any) => { top.push(n); for(const c of n.calls ?? []) flatten(c); };
  flatten(tree);
  const used = (sel: string, addr?: string) => top.filter((c: any) => c.input?.toLowerCase().startsWith(sel) && (!addr || c.to?.toLowerCase() === addr.toLowerCase())).reduce((a: bigint, c: any) => a + BigInt(c.gasUsed ?? "0x0"), 0n);
  const accountValidation = used(VALIDATE_USER_OP, op.sender);
  const pmValidation = used(VALIDATE_PM, op.paymaster);
  const postOp = used(POST_OP, op.paymaster);
  const execution = used(op.callData.slice(0, 10).toLowerCase(), op.sender);
  const factory = op.factory ? top.filter((c:any) => c.to?.toLowerCase() !== op.sender.toLowerCase() && c.to?.toLowerCase() !== op.paymaster?.toLowerCase() && c.input?.startsWith("0x570e1a36")).reduce((a:bigint,c:any)=>a+BigInt(c.gasUsed),0n) : 0n;
  return { validationGas: accountValidation.toString(), factoryGas: factory.toString(), paymasterValidationGas: pmValidation.toString(), executionGas: execution.toString(), postOpGas: postOp.toString(), totalGas: BigInt(tree.gasUsed ?? "0x0").toString() };
}
async function gasOf(op: UserOp) {
 const tree = await rpc<any>("debug_traceCall", [{ from: anvil.address, to: ENTRYPOINT_V07, data: handleOpsData(op), gas: toHex(30_000_000n) }, "latest", { tracer: "callTracer" }]);
 return gasFromTree(op, tree);
}

async function include(op: UserOp, paymaster: Address) {
  const before = op.paymaster ? await pc.readContract({ address: paymaster, abi: pmAbi, functionName: "creditOf", args: [op.sender] }) : 0n;
  const data = handleOpsData(op);
  const hash = await wallet.sendTransaction({ to: ENTRYPOINT_V07, data, gas: 28_000_000n });
  const rc = await pc.waitForTransactionReceipt({ hash });
  const after = await pc.readContract({ address: paymaster, abi: pmAbi, functionName: "creditOf", args: [op.sender] });
  let actualGasUsed = "";
  let executionSuccess: boolean | undefined;
  let chargedEvent: string | undefined;
  let actualGasCost = "";
  for (const log of rc.logs) {
    try { const d = decodeEventLog({ abi: pmArt.abi as never, data: log.data, topics: log.topics }); if (d.eventName === "UserOperationCharged") chargedEvent = (d.args as any).gasCostToken.toString(); } catch {}
  }
  for (const log of rc.logs) {
    try {
      const d = decodeEventLog({ abi: epAbi, data: log.data, topics: log.topics });
      if (d.eventName === "UserOperationEvent") {
        const args = d.args as { success: boolean; actualGasUsed: bigint; actualGasCost: bigint };
        actualGasUsed = args.actualGasUsed.toString();
        actualGasCost = args.actualGasCost.toString();
        executionSuccess = args.success;
      }
    } catch { /* not this event */ }
  }
  const tree = await rpc<any>("debug_traceTransaction", [hash, {tracer: "callTracer"}]);
  const remainingReservation = await pc.readContract({address:paymaster,abi:pmAbi,functionName:"reservedOf",args:[op.sender]});
  if(op.paymaster && (chargedEvent === undefined || remainingReservation !== 0n)) throw new Error("postOp did not emit charge / clean reservation");
  return { reservedAfter: remainingReservation.toString(), status: rc.status, charged: chargedEvent, creditDelta: (before - after).toString(), hash, actualGasUsed, actualGasCost, executionSuccess, tree, phaseGas: gasFromTree(op, tree), receiptGasUsed: rc.gasUsed.toString(), effectiveGasPrice: actualGasUsed ? (BigInt(actualGasCost) / BigInt(actualGasUsed)).toString() : undefined };
}

async function signPaymaster(op: UserOp, pm: Address, signer: ReturnType<typeof privateKeyToAccount>, launch: boolean, now: number): Promise<UserOp> {
  const validAfter = Number((await pc.getBlock()).timestamp) - 30;
  const q: PaymasterQuote = { validUntil: validAfter + 600, validAfter, rate: RATE, maxTokenCost: requiredMaxTokenCost(op, RATE) };
  const isSession = op.callData.startsWith(EXECUTE_USER_OP);
  const hash = launch ? paymasterLaunchQuoteHash(op, q, chain.id, pm) : isSession ? paymasterAllowanceHash(op.sender, q, chain.id, pm) : paymasterQuoteHash(op, q, chain.id, pm);
  const sig = await signer.signMessage({ message: { raw: hash } });
  return { ...op, paymasterData: encodePaymasterData(q, sig) };
}

async function main() {
  if (!(await rpc<string>("web3_clientVersion", [])).startsWith("anvil/")) throw new Error("Anvil required");
  if (await pc.getChainId() !== 46630) throw new Error("RH testnet fork only");
  mkdirSync(new URL("./traces/", import.meta.url), { recursive: true });
  const block = await pc.getBlock();
  const base = block.baseFeePerGas ?? await pc.getGasPrice();
  const maxFee = base * 2n + 1_100_000n;
  const now = Number(block.timestamp);
  console.log("fork baseFee", base.toString(), "time", now);

  const dev = (addressIndex: number) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex });
  const owner = dev(1);
  const session = dev(2);
  const pmSigner = dev(3);

  const pmData = encodeDeployData({
    abi: pmArt.abi as never, bytecode: pmArt.bytecode.object,
    args: [ENTRYPOINT_V07, USDG, anvil.address, pmSigner.address, anvil.address, 1n, 10n ** 15n, 7_068_712n, 150_000n],
  });
  const pmRc = await send(pmData);
  const paymaster = pmRc.contractAddress!;
  const polData = encodeDeployData({ abi: polArt.abi as never, bytecode: polArt.bytecode.object, args: [zeroAddress, paymaster] });
  const polRc = await send(polData);
  const policy = polRc.contractAddress!;
  await send(encodeFunctionData({ abi: pmAbi, functionName: "setLaunchGasLimit", args: [21_940_348n] }), paymaster);
  await send(encodeFunctionData({ abi: epAbi, functionName: "addStake", args: [UNSTAKE_DELAY] }), paymaster, LIVE_STAKE);
  await send(encodeFunctionData({ abi: epAbi, functionName: "depositTo", args: [paymaster] }), ENTRYPOINT_V07, 13_043_478_260_869_566n);
  const st = await stakeOf(paymaster);
  console.log("paymaster", paymaster, "policy", policy, "stake", st.stake.toString(), "delay", st.delay.toString(), "deposit", st.deposit.toString());

  const sender = await pc.readContract({ address: MAV2_FACTORY, abi: factoryAbi, functionName: "getAddressSemiModular", args: [owner.address, salt] });
  await rpc("anvil_setBalance", [sender, toHex(10n ** 18n)]);
  await send(encodeFunctionData({ abi: erc20, functionName: "mint", args: [sender, 50_000_000n] }), USDG);
  console.log("account", sender, "usdg", (await pc.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [sender] })).toString());

  const installed = buildCreateSession({
    now, ttlSec: 3600, entityId: ENTITY,
    modules: { policy, singleSigner: SINGLE, timeRange: TIME_RANGE },
    targets: { router: ROUTER, launchpad: LAUNCHPAD, trampWallManager: TRAMP },
    sessionSigner: session.address,
    caps: [{ token: USDG, cap: (1n << 128n) - 1n }, { token: "0xF5eB226F7f0890c36A06Cbd0Ff843292b7b1a88C", cap: (1n << 128n) - 1n }],
    permissions: TRADE_PERMS | Perm.LAUNCH,
  });
  const nonces = new Nonces();
  const ownerClient = await createModularAccountV2Client({
    chain, transport: http(RPC), signer: new LocalAccountSigner(owner), salt, factoryAddress: MAV2_FACTORY,
    feeEstimator: async (s) => s, gasEstimator: async (s) => s,
  });
  const sessionClient = await createModularAccountV2Client({
    chain, transport: http(RPC), signer: new LocalAccountSigner(session), accountAddress: sender,
    signerEntity: { entityId: ENTITY, isGlobalValidation: false },
    feeEstimator: async (s) => s, gasEstimator: async (s) => s,
  });

  async function userOp(calls: Call[], opts: { session: boolean; limits: Limits; launch?: boolean; deploy?: boolean }): Promise<UserOp> {
    const callData = batch(calls, opts.session);
    const nonce = nonces.next(opts.session ? ENTITY : 0, !opts.session);
    let op: UserOp = {
      sender, nonce: toHex(nonce), callData,
      callGasLimit: toHex(opts.limits.callGasLimit), verificationGasLimit: toHex(opts.limits.verificationGasLimit),
      preVerificationGas: toHex(opts.limits.preVerificationGas),
      maxFeePerGas: toHex(opts.session ? maxFee * 2n : maxFee), maxPriorityFeePerGas: toHex(1_100_000n),
      paymaster, paymasterVerificationGasLimit: toHex(PAYMASTER_GAS.verificationGasLimit),
      paymasterPostOpGasLimit: toHex(PAYMASTER_GAS.postOpGasLimit), paymasterData: "0x", signature: "0x",
    };
    if (opts.deploy) {
      op.factory = MAV2_FACTORY;
      op.factoryData = encodeFunctionData({ abi: factoryAbi, functionName: "createSemiModularAccount", args: [owner.address, salt] });
    }
    op = await signPaymaster(op, paymaster, pmSigner, !!opts.launch, now);
    const client = opts.session ? sessionClient : ownerClient;
    const signed = await client.signUserOperation({ uoStruct: op as never });
    return { ...op, signature: (signed as { signature: Hex }).signature };
  }

  const setupCalls = [...setupCreditCalls(USDG, paymaster, sender, SETUP_DEPOSIT), { to: sender, data: installed.data, value: 0n }];
  const buyAmount = 1_000_000n;
  let minOut = 1n;
  try {
    const q = await pc.simulateContract({ address: ROUTER, abi: routerAbi, functionName: "quoteUsdgRouteFor", args: [sender, COIN, true, buyAmount], account: sender });
    minOut = q.result[0] * 99n / 100n;
  } catch (e) { console.log("quote failed", (e as Error).message?.slice(0, 160)); }
  const buyCalls: Call[] = [
    { to: USDG, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, buyAmount] }) },
    { to: ROUTER, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "buyWithUsdg", args: [COIN, buyAmount, minOut, BigInt(now + 600)] }) },
  ];
  const deadline = BigInt(now + 600);
  const launchCall: Call = { to: LAUNCHPAD, value: 0n, data: encodeFunctionData({
    abi: launchAbi, functionName: "launchWithMode",
    args: [{ name: "ERC7562", ticker: "E7562", imageURI: "ipfs://erc7562", description: "local fork check", socialsURI: "", quote: USDG, creatorTaxBps: 100n, creatorBuyQuoteIn: 0n, creatorBuyMinTokensOut: 0n, deadline }, 0],
  }) };

  const results: Verdict[] = [];
  const record = async (name: string, op: UserOp, mine: boolean) => {
    console.log("trace", name);
    const v = await traceRules(name, op, paymaster);
    try { Object.assign(v, await gasOf(op)); } catch (e) { v.detail += ` | gas trace: ${(e as Error).message?.slice(0, 120)}`; }
    
    if (mine && v.admitted) {
      try {
        const inc = await include(op, paymaster);
        v.actualGasUsed = inc.actualGasUsed;
        v.executionSuccess = inc.executionSuccess;
        v.usdgCharged = inc.charged;
        Object.assign(v, inc.phaseGas, {txHash: inc.hash, effectiveGasPrice: inc.effectiveGasPrice, receiptGasUsed: inc.receiptGasUsed, actualGasCost: inc.actualGasCost, reservedAfter: inc.reservedAfter});
        writeFileSync(new URL(`./traces/${name[0]}-included-calltree.json`, import.meta.url), JSON.stringify(inc.tree, null, 2));
        v.detail += ` | included ${inc.status} execution ${inc.executionSuccess} charged ${inc.charged} creditDelta ${inc.creditDelta} actualGasUsed ${inc.actualGasUsed}`;
      } catch (e) { v.detail += ` | include failed ${(e as Error).message?.slice(0, 180)}`; v.admitted = false; }
    }
    results.push(v);
    console.log(JSON.stringify(v));
    return v;
  };

  // (a) site setup: $2 + session install, zero credit, owner prompt.
  const setup = await userOp(setupCalls, { session: false, limits: SETUP_LIMITS, deploy: true });
  const need = requiredMaxTokenCost(setup, RATE);
  console.log("setup maxTokenCost", need.toString(), "deposit", SETUP_DEPOSIT.toString());
  const a = await record("a setup $2 + session install", setup, true);

  if (!a.admitted || (await pc.getBytecode({ address: sender })) === undefined) {
    if ((await pc.getBytecode({ address: sender })) === undefined) {
      await send(encodeFunctionData({ abi: factoryAbi, functionName: "createSemiModularAccount", args: [owner.address, salt] }), MAV2_FACTORY);
    }
    const installOp = await userOp([{ to: sender, data: installed.data, value: 0n }], { session: false, limits: SETUP_LIMITS });
    installOp.paymaster = undefined; installOp.paymasterData = undefined; installOp.paymasterVerificationGasLimit = undefined; installOp.paymasterPostOpGasLimit = undefined;
    const reSigned = await ownerClient.signUserOperation({ uoStruct: installOp as never });
    installOp.signature = (reSigned as { signature: Hex }).signature;
    try { await include(installOp, paymaster); console.log("session installed via self-paid owner op"); }
    catch (e) { console.log("self-paid install failed", (e as Error).message?.slice(0, 240)); }
    const fund = need * 4n;
    await send(encodeFunctionData({ abi: erc20, functionName: "mint", args: [anvil.address, fund] }), USDG);
    await send(encodeFunctionData({ abi: erc20, functionName: "approve", args: [paymaster, fund] }), USDG);
    await send(encodeFunctionData({ abi: pmAbi, functionName: "deposit", args: [sender, fund] }), paymaster);
    console.log("funded credit", fund.toString());
  }

  const walletUsdg = await pc.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [sender] });
  const creditNow = await pc.readContract({ address: paymaster, abi: pmAbi, functionName: "creditOf", args: [sender] });
  const reservedNow = await pc.readContract({ address: paymaster, abi: pmAbi, functionName: "reservedOf", args: [sender] });
  const availableNow = creditNow > reservedNow ? creditNow - reservedNow : 0n;
  const topped = withAutoTopUp(buyCalls, { usdg: USDG, paymaster, account: sender, available: availableNow, wallet: walletUsdg });
  console.log("top-up calls", topped.length, "available", availableNow.toString(), "wallet", walletUsdg.toString());
  let sellCalls: Call[] = [
    { to: COIN, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, 1n] }) },
    { to: ROUTER, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "sellToUsdg", args: [COIN, 1n, 0n, deadline] }) },
  ];

  await record("b session boost buy", await userOp(buyCalls, { session: true, limits: TRADE_LIMITS }), true);
  await record("c buy + hidden top-up batch", await userOp(withAutoTopUp(buyCalls, {usdg:USDG,paymaster,account:sender,available:await pc.readContract({address:paymaster,abi:pmAbi,functionName:"creditOf",args:[sender]}),wallet:await pc.readContract({address:USDG,abi:erc20,functionName:"balanceOf",args:[sender]})}), { session: true, limits: TRADE_LIMITS }), true);
  const sellAmount = (await pc.readContract({address: COIN, abi: erc20, functionName: "balanceOf", args: [sender]})) / 4n;
  const sellQuote = await pc.simulateContract({address: ROUTER, abi: routerAbi, functionName: "quoteUsdgRouteFor", args:[sender,COIN,false,sellAmount], account:sender});
  const sellMin = sellQuote.result[0] * 99n / 100n;
  if (sellAmount === 0n || sellMin === 0n) throw new Error("Cannot build realistic sell quote");
  sellCalls = [
    {to:COIN,value:0n,data:encodeFunctionData({abi:erc20,functionName:"approve",args:[ROUTER,sellAmount]})},
    {to:ROUTER,value:0n,data:encodeFunctionData({abi:routerAbi,functionName:"sellToUsdg",args:[COIN,sellAmount,sellMin,deadline]})}
  ];
  await record("d session sell", await userOp(sellCalls, { session: true, limits: TRADE_LIMITS }), true);
  await record("e owner launch", await userOp([launchCall], { session: false, limits: LAUNCH_LIMITS, launch: true }), true);
  const freshCredit = await pc.readContract({ address: paymaster, abi: pmAbi, functionName: "creditOf", args: [sender] });
  const freshReserved = await pc.readContract({ address: paymaster, abi: pmAbi, functionName: "reservedOf", args: [sender] });
  const freshWallet = await pc.readContract({ address: USDG, abi: erc20, functionName: "balanceOf", args: [sender] });
  const free = freshCredit > freshReserved ? freshCredit - freshReserved : 0n;
  const sendAmount = freshWallet + 100_000n;
  let sendCalls: Call[];
  try {
    sendCalls = usdgSendCalls({ usdg: USDG, paymaster, to: anvil.address, amount: sendAmount, wallet: freshWallet, available: free, gasReserve: SEND_CREDIT_LOCK });
  } catch (e) {
    results.push({ name: "f withdraw/send release", admitted: false, detail: (e as Error).message, dependsOnStake: false, maxFeePerGas: toHex(maxFee) });
    sendCalls = [];
  }
  // ERC20 transfer is not session-eligible, so the site signs this batch with the owner.
  if (sendCalls.length) await record("f withdraw/send release", await userOp(sendCalls, { session: false, limits: TRADE_LIMITS }), true);

  const doc = {
    tool: "eth-infinitism/bundler BundlerCollectorTracer + tracerResultParser @ aae77140e5c2b1386d04eaeba2d23fc17a62bd87",
    anvil: await rpc<string>("web3_clientVersion", []), rundler: "v0.11.0 binary expects native erc7562Tracer, which anvil does not provide; not used for the verdict",
    forkBlock: block.number.toString(), forkBlockHash: block.hash, forkAdvertisedGasPrice: (await pc.getGasPrice()).toString(), limits: {trade:TRADE_LIMITS,setup:SETUP_LIMITS,launch:LAUNCH_LIMITS},
    chainId: 46630, baseFee: base.toString(), rate: RATE.toString(), liveStake: LIVE_STAKE.toString(),
    paymaster, policy, sender, setupMaxTokenCost: need.toString(), setupDeposit: SETUP_DEPOSIT.toString(),
    siteSetupAdmitted: a.admitted, results,
  };
  const out = new URL("./results.json", import.meta.url);
  writeFileSync(out, JSON.stringify(doc, (_,v)=>typeof v === "bigint" ? v.toString() : v, 2));
  console.log("wrote", out.pathname);
  writeFileSync(new URL("./gas.csv", import.meta.url), "op,admission,execution_success,account_validation,factory_validation,pm_validation,execution,postop,event_actual_gas,receipt_gas,charged_usdg_base_units,effective_wei_per_gas\n" + results.map((r:any)=>[r.name,r.admitted ? "ADMITTED" : "REJECTED",r.executionSuccess,r.validationGas,r.factoryGas,r.paymasterValidationGas,r.executionGas,r.postOpGas,r.actualGasUsed,r.receiptGasUsed,r.usdgCharged,r.effectiveGasPrice].join(",")).join("\n") + "\n");
  console.table(results.map((r:any)=>({op:r.name, verdict:r.admitted ? "ADMITTED" : "REJECTED", execution:r.executionSuccess, accountValidation:r.validationGas, factory:r.factoryGas, pmValidation:r.paymasterValidationGas, executionGas:r.executionGas, postOp:r.postOpGas, actualGas:r.actualGasUsed, usdg:r.usdgCharged, priceWei:r.effectiveGasPrice})));
}

main().catch((e) => { console.error(e); process.exit(1); });

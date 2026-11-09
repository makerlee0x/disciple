/* eslint-disable @typescript-eslint/no-explicit-any -- one-off ops script, mirrors scripts/gasless-phase2.mts */
/**
 * PREPARED, NOT RUN. Closest legitimate revocation test for the self-bundler (PR #264).
 *
 * Why not the real account 0xf4C6…1109: its owner (code tail) is the Privy embedded wallet 0x72f6…969a.
 * No key we legitimately control owns it, so its owner-side revoke is out of scope by rule.
 *
 * Instead: Phase-2 disposable fixture #2 (0x64a9…d941). Its owner key is a disposable testnet key created by
 * the Phase-2 harness, so we do control it. Exact cost: 2 owner UserOps, 0 trade UserOps, 1 rejected POST.
 *   op 1 (owner): install a FRESH session (in-RAM key, short validUntil), the same SDK calldata the app uses.
 *   op 2 (owner): uninstall it (buildUninstallSession, the app's End-session calldata).
 *   then: zero-op read-only checks (sessionOf cleared, exact handleOps eth_call with the revoked key reverts)
 *   and ONE disciple_sendUserOperationSync POST to the Preview alias that must return notSent with the relayer
 *   nonce unchanged.
 * Gas: the fixture has 0 ETH, 0 USDG and 0 credit, and Preview runs self mode (no BSO). So the two owner ops are
 * paid from the fixture's EntryPoint deposit. The deployer acts only as funder and bundler: one optional native
 * depositTo of existing testnet ETH, plus two native handleOps txs carrying the owner-signed ops. The deployer
 * never signs as the owner. That depositTo needs approval, since it moves existing test funds.
 *
 * Gates: default = read-only preflight. --run additionally needs REVOCATION_APPROVED=1, the deployer env sourced
 * in the same command (never echoed) and the Preview share token on stdin. Hard cap: 2 owner ops, 1 POST.
 * Every owner op is exact-simulated first (eth_call handleOps). Any surprise => STOP, no retry.
 * Never prints keys, the RPC URL or the share token.
 */
import { createPublicClient, createWalletClient, custom, http, encodeFunctionData, parseAbi, concat, pad, numberToHex, decodeErrorResult, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createModularAccountV2 } from "@account-kit/smart-contracts";
import { LocalAccountSigner } from "@aa-sdk/core";
import { buildCreateSession, buildUninstallSession, TRADE_PERMS } from "@disciple/session-keys";
import { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } from "@account-kit/smart-contracts/experimental";

const RUN = process.argv.includes("--run");
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address, FIX = "0x64a9904b9Dc4835C4a68B3Fde7C84ED081aFd941" as Address;
const REAL = "0xf4C6B87aDBf4D762dfD104415B537b2cf5551109" as Address, RELAYER = "0xa589d5d1cD0D52f547AF4Ee3dF05383cdee26C64" as Address;
const LOGIN = "0xebDD6Ad15a6B838eE15Dc7d5871F09EFB284317D" as Address, POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2" as Address;
const USDG = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d" as Address, ROUTER = "0x688160633b22012717661545df6299d3d3174ad2" as Address, COIN = "0xab9e86498c9b32743e31b0fca02d6b254bcddd4e" as Address;
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd" as Address, GAS_TEMPLATE = "0x3a9664d9c02e3693368a2bdf04e19a8a6a634ebedd6e08bf9a1c876e1b15c759" as Hex;
const OUT = "/workspace/self-bundler-revocation/fixture-probe-evidence.json";
const ct = () => new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }) + " CT";
const js = (x: unknown) => JSON.stringify(x, (_, y) => (typeof y === "bigint" ? String(y) : y), 2);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ev: any = { type: "fixture revocation probe", mode: RUN ? "run" : "preflight", startCT: ct(), rpc: "[REDACTED]", share: "[REDACTED]", ownerOpsSent: 0, posts: 0 };
const save = () => writeFileSync(OUT, js(ev) + "\n", { mode: 0o600 });

const rpc = readFileSync(new URL("../lib/chains.ts", import.meta.url), "utf8").match(/"([^"\n]*rpc\.testnet[^"\n]*)"/)![1];
const chain = { id: 46630, name: "rh-testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const pc = createPublicClient({ chain, transport: http(rpc, { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
const abi = parseAbi([
  "function verifiedUntil(address) view returns (uint64)", "function getNonce(address,uint192) view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function getAddressSemiModular(address,uint256) view returns (address)", "function depositTo(address) payable", "function quoteUsdgRouteFor(address,address,bool,uint256) view returns (uint256,uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "error FailedOp(uint256 opIndex, string reason)", "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "function executeBatch((address target,uint256 value,bytes data)[])", "function approve(address,uint256)", "function buyWithUsdg(address,uint256,uint256,uint256)",
]);
const sessAbi = parseAbi(["function sessionOf(address,uint32) view returns ((bool active, uint64 spent0, uint64 spent1, (uint48 validUntil, uint16 maxSlippageBps) cfg))"]);
const read = (address: Address, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args } as any) as Promise<any>;
const sessionOf = (e: number) => pc.readContract({ address: POLICY, abi: sessAbi, functionName: "sessionOf", args: [FIX, e] }).catch(() => null);
const p16 = (x: bigint) => pad(numberToHex(x), { size: 16 });
type Packed = { sender: Address; nonce: bigint; initCode: Hex; callData: Hex; accountGasLimits: Hex; preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex; signature: Hex };
async function simulate(op: Packed, from: Address) {
  try { await pc.call({ account: from, to: EP, data: encodeFunctionData({ abi, functionName: "handleOps", args: [[op], from] }) }); return { ok: true }; }
  catch (e: any) { let d: Hex | undefined; e.walk?.((x: any) => { if (typeof x?.data === "string" && /^0x[0-9a-f]{8,}$/i.test(x.data)) { d = x.data; return true; } return false; });
    if (!d) return { ok: false, reason: "undecodable" }; const r = decodeErrorResult({ abi, data: d }); return { ok: false, error: r.errorName, reason: String((r.args as any)[1]) }; }
}
const relayerNonces = async () => ({ latest: await pc.getTransactionCount({ address: RELAYER, blockTag: "latest" }), pending: await pc.getTransactionCount({ address: RELAYER, blockTag: "pending" }) });

try {
  save();
  if ((await pc.getChainId()) !== 46630) throw Error("STOP wrong chain");
  const rec = JSON.parse(readFileSync("/workspace/gasless-phase2-disposable-fixtures.json", "utf8"))[1];
  const owner = privateKeyToAccount(rec.owner as Hex); // disposable fixture owner key we created; never printed
  if (!eq(await read(FACTORY, "getAddressSemiModular", [owner.address, 0n]), FIX)) throw Error("STOP fixture owner binding mismatch");
  const code = await pc.getCode({ address: FIX }); if (!code || !eq("0x" + code.slice(-40), owner.address)) throw Error("STOP fixture code-tail owner mismatch");
  const modules = { policy: POLICY, singleSigner: getDefaultSingleSignerValidationModuleAddress(chain as any), timeRange: getDefaultTimeRangeModuleAddress(chain as any) };
  const [block, depositWei, ethWei, loginUntil, fees, tx] = await Promise.all([pc.getBlock(), pc.getBalance({ address: FIX }).then(() => read(EP, "balanceOf", [FIX])), pc.getBalance({ address: FIX }), read(LOGIN, "verifiedUntil", [FIX]), pc.estimateFeesPerGas(), pc.getTransaction({ hash: GAS_TEMPLATE })]);
  const maxFee = fees.maxFeePerGas! * 2n, tip = fees.maxPriorityFeePerGas ?? 1n;
  const VGL = 400_000n, CGL = 700_000n, PVG = 80_000n, perOpMaxWei = (VGL + CGL + PVG) * maxFee;
  Object.assign(ev, { preflightCT: ct(), block: block.number, fixture: FIX, owner: owner.address, ownerControlledDisposable: true, realAccountOwnerControlled: false,
    fixtureEthWei: ethWei, fixtureEntryPointDepositWei: depositWei, fixtureLoginGateVerifiedUntil: loginUntil, maxFeePerGasWei: maxFee, perOwnerOpMaxPrefundWei: perOpMaxWei,
    requiredDepositForTwoOpsWei: 2n * perOpMaxWei, depositShortfallWei: depositWei >= 2n * perOpMaxWei ? 0n : 2n * perOpMaxWei - depositWei,
    exactOpCost: { ownerUserOps: 2, tradeUserOps: 0, rejectedPreviewPosts: 1, nativeTxs: "2 handleOps + (1 depositTo only if shortfall > 0)" },
    caveat: "LoginGate verifiedUntil is 0 for the fixture, so the hosted rejection will be the LoginGate gate (first in admission), not the session gate. On-chain revocation is proven by sessionOf + exact eth_call; the session gate itself is covered by unit tests." });
  save();
  if (!RUN) { console.log(js({ preflight: "ok", ...ev })); process.exit(0); }

  // ---------- RUN (approval required) ----------
  if (process.env.REVOCATION_APPROVED !== "1") throw Error("STOP REVOCATION_APPROVED=1 required");
  const share = readFileSync(0, "utf8").trim(); if (!/^[a-zA-Z0-9]+$/.test(share)) throw Error("STOP share token must arrive on stdin");
  const deployer = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  if (!eq(deployer.address, process.env.DEPLOYER_ADDRESS ?? "") || eq(deployer.address, owner.address)) throw Error("STOP deployer mismatch");
  const wc = createWalletClient({ account: deployer, chain, transport: http(rpc, { retryCount: 0 }) });
  const acct = await createModularAccountV2({ chain: chain as any, transport: custom(pc) as any, signer: LocalAccountSigner.privateKeyToAccountSigner(rec.owner as Hex), accountAddress: FIX });
  if (!eq(acct.address, FIX)) throw Error("STOP SDK account mismatch");
  if (ev.depositShortfallWei > 0n) {
    if (ev.depositShortfallWei > 100_000_000_000_000n) throw Error("STOP shortfall above 0.0001 ETH cap");
    const h = await wc.writeContract({ address: EP, abi, functionName: "depositTo", args: [FIX], value: ev.depositShortfallWei });
    const r = await pc.waitForTransactionReceipt({ hash: h }); ev.depositTx = { hash: h, status: r.status, ct: ct() }; save(); if (r.status !== "success") throw Error("STOP depositTo reverted");
  }
  async function ownerOp(label: string, data: Hex) {
    if (ev.ownerOpsSent >= 2) throw Error("STOP owner-op cap");
    const callData = await acct.encodeCalls([{ target: FIX, data }]) as Hex;
    const op: Packed = { sender: FIX, nonce: await acct.getAccountNonce(), initCode: "0x", callData, accountGasLimits: concat([p16(VGL), p16(CGL)]), preVerificationGas: PVG, gasFees: concat([p16(tip), p16(maxFee)]), paymasterAndData: "0x", signature: "0x" };
    const hash = await read(EP, "getUserOpHash", [op]) as Hex; op.signature = await acct.signUserOperationHash(hash) as Hex;
    const sim = await simulate(op, deployer.address); ev[label] = { userOpHash: hash, simulation: sim, ct: ct() }; save();
    if (!sim.ok) throw Error(`STOP ${label} exact simulation failed`);
    ev.ownerOpsSent++; save();
    const h = await wc.writeContract({ address: EP, abi, functionName: "handleOps", args: [[op], deployer.address], gas: 1_500_000n });
    const r = await pc.waitForTransactionReceipt({ hash: h }); Object.assign(ev[label], { txHash: h, status: r.status, block: r.blockNumber }); save();
    if (r.status !== "success") throw Error(`STOP ${label} reverted; no retry`);
  }
  const sessionKey = privateKeyToAccount(generatePrivateKey()); // in RAM only; discarded at exit
  const now = Number((await pc.getBlock()).timestamp);
  const setup = buildCreateSession({ now, modules, targets: { router: ROUTER } as any, sessionSigner: sessionKey.address, ttlSec: 900, permissions: TRADE_PERMS, caps: [{ token: USDG, cap: 1_000_000n }] } as any);
  await ownerOp("op1_installSession", setup.data as Hex);
  const live = await sessionOf(setup.entityId); ev.afterInstall = live; save(); if (!live?.active) throw Error("STOP install did not activate");
  await ownerOp("op2_uninstallSession", buildUninstallSession(setup.entityId, modules as any) as Hex);
  const dead = await sessionOf(setup.entityId); ev.afterRevoke = dead; save(); if (dead?.active) throw Error("STOP revoke left session active");

  // Zero-op: a canonical trade signed by the revoked key, exact-simulated read-only, then ONE Preview POST.
  const tpl = (await import("viem")).decodeFunctionData({ abi, data: (await pc.getTransaction({ hash: GAS_TEMPLATE })).input }).args![0] as any[];
  const t = tpl[0] as Packed; const key = (BigInt(setup.entityId) << 8n);
  const q = await read(ROUTER, "quoteUsdgRouteFor", [FIX, COIN, true, 200_000n]);
  const calls = encodeFunctionData({ abi, functionName: "executeBatch", args: [[{ target: USDG, value: 0n, data: encodeFunctionData({ abi, functionName: "approve", args: [ROUTER, 200_000n] }) }, { target: ROUTER, value: 0n, data: encodeFunctionData({ abi, functionName: "buyWithUsdg", args: [COIN, 200_000n, (q[0] * 99n) / 100n || 1n, BigInt(now + 600)] }) }]] });
  const probe: Packed = { ...t, sender: FIX, nonce: await read(EP, "getNonce", [FIX, key]), callData: ("0x8dd7712f" + calls.slice(2)) as Hex, signature: "0x" };
  const ph = await read(EP, "getUserOpHash", [probe]) as Hex; probe.signature = concat(["0xff00", await sessionKey.signMessage({ message: { raw: ph } })]);
  ev.probeSimulation = await simulate(probe, RELAYER); save(); if (ev.probeSimulation.ok) throw Error("STOP revoked key still simulates OK; no POST");
  const before = await relayerNonces(); const nonceBefore = probe.nonce;
  const unpack = (p: Packed) => ({ sender: p.sender, nonce: numberToHex(p.nonce), callData: p.callData, verificationGasLimit: numberToHex(BigInt(p.accountGasLimits.slice(0, 34))), callGasLimit: numberToHex(BigInt("0x" + p.accountGasLimits.slice(34))), preVerificationGas: numberToHex(p.preVerificationGas), maxPriorityFeePerGas: numberToHex(BigInt(p.gasFees.slice(0, 34))), maxFeePerGas: numberToHex(BigInt("0x" + p.gasFees.slice(34))), paymaster: p.paymasterAndData.slice(0, 42), paymasterVerificationGasLimit: numberToHex(BigInt("0x" + p.paymasterAndData.slice(42, 74))), paymasterPostOpGasLimit: numberToHex(BigInt("0x" + p.paymasterAndData.slice(74, 106))), paymasterData: ("0x" + p.paymasterAndData.slice(106)) as Hex, signature: p.signature });
  ev.posts++; save();
  const res = spawnSync("python3", ["/workspace/self-bundler-abuse-http.py"], { input: JSON.stringify({ share, body: { jsonrpc: "2.0", id: 1, method: "disciple_sendUserOperationSync", params: [unpack(probe), EP, { pressId: "revoked-" + crypto.randomUUID() }] } }), encoding: "utf8", timeout: 65000 });
  ev.response = JSON.parse(res.stdout); await new Promise((r) => setTimeout(r, 2000));
  const after = await relayerNonces(); const nonceAfter = await read(EP, "getNonce", [FIX, key]);
  const f = ev.response.frames ?? []; ev.result = { notSent: f.length === 1 && f[0].kind === "error" && f[0].data?.notSent === true && !f[0].data?.txHash, error: f[0]?.message, relayerBefore: before, relayerAfter: after, senderNonceUnchanged: nonceAfter === nonceBefore };
  ev.endCT = ct(); save(); console.log(js(ev.result));
  if (!ev.result.notSent || before.latest !== after.latest || before.pending !== after.pending || !ev.result.senderNonceUnchanged) { console.error("CRITICAL revoked-session probe not rejected cleanly"); process.exitCode = 2; }
} catch (e: any) {
  ev.stop = { ct: ct(), message: String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].replace(/https?:\/\/\S+/g, "[URL REDACTED]") };
  save(); console.error(js({ STOP: ev.stop })); process.exitCode = 1;
}

/**
 * USDG-gas e2e on an anvil FORK of RH testnet (chain 46630; nothing is sent to the real testnet):
 *   - deploys DisciplePaymaster + DiscipleSessionPolicy 1.4.0 on the fork (forge artifacts in contracts/out)
 *   - serves /api/bundler and /api/paymaster IN-PROCESS (the real Next route handlers) on a local port
 *   - fresh MAv2 account with ZERO ETH, only mUSDG:
 *       1. owner op deploys the account + mints STRATEGY; gas paid in USDG (ETH balance stays 0)
 *       2. owner installs a session on policy 1.4.0
 *       3. session key: approve + buy via the router, gas paid in USDG (exact paymaster approve, counted on the cap)
 *       4. with the paymaster unset the same account falls back to ETH prefund ⇒ FundAccount (it holds no ETH)
 * Keys: random per run (signer, owner, session) + anvil's public dev accounts; nothing is printed.
 *   cd contracts && forge build (once) ;  cd web && npx tsx --conditions=react-server scripts/test-paymaster-e2e.mts
 * Env: FORK_RPC (default RH testnet), ANVIL_PORT (39545), APP_PORT (39471).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const FORK = process.env.FORK_RPC || "https://rpc.testnet.chain.robinhood.com";
const AP = Number(process.env.ANVIL_PORT || 39545), PORT = Number(process.env.APP_PORT || 39471);
const RPC = `http://127.0.0.1:${AP}`, APP = `http://127.0.0.1:${PORT}`;
// anvil's well-known public dev keys (not secrets): #0 deployer/owner, #1 relayer
const DEV0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const DEV1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

let failures = 0;
const ok = (k: string, cond: boolean, v = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${k}${v ? `: ${v}` : ""}`); if (!cond) failures++; };

const anvil = spawn("anvil", ["--fork-url", FORK, "--port", String(AP), "--silent", "--block-time", "1"], { stdio: "ignore" });
const stop = () => { try { anvil.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);
for (let i = 0; ; i++) {
  try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }); if (r.ok) break; } catch { /* starting */ }
  if (i > 150) { console.error("anvil did not start"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}

// env BEFORE the app modules load (chains.ts reads the RPC + paymaster at import time)
process.env.NEXT_PUBLIC_RHT_RPC_URL = RPC;
process.env.NEXT_PUBLIC_SESSION_POLICY_VERSION = "1.4.0";
process.env.RELAYER_PRIVATE_KEY = DEV1;
process.env.PAYMASTER_SIGNER_KEY = generatePrivateKey();
process.env.KV_LOCAL_FILE = `/tmp/disciple-kv-e2e-${process.pid}.json`;
process.env.AA_SELF_BUNDLER = "1";
delete process.env.ALCHEMY_API_KEY; delete process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;

const { robinhoodTestnet, DEPLOYMENTS, TESTNET_COINS } = await import("../lib/chains");
const d = DEPLOYMENTS[46630];
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(RPC) });
const dev = createWalletClient({ chain: robinhoodTestnet, transport: http(RPC), account: privateKeyToAccount(DEV0) });
const art = (f: string, c: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${f}/${c}.json`, import.meta.url), "utf8")) as { abi: never; bytecode: { object: Hex } };
const deploy = async (f: string, c: string, args: unknown[]) => {
  const a = art(f, c);
  const hash = await dev.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: args as never });
  const rc = await pc.waitForTransactionReceipt({ hash });
  return rc.contractAddress as Address;
};

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const signer = privateKeyToAccount(process.env.PAYMASTER_SIGNER_KEY as Hex).address;
const usdgDec = await pc.readContract({ address: d.usdg, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
const one = BigInt(10) ** BigInt(usdgDec);
const RATE = BigInt(3000) * one;  // $3000/ETH: USDG base units per 1e18 wei
const pm = await deploy("DisciplePaymaster.sol", "DisciplePaymaster", [EP, d.usdg, dev.account.address, signer, dev.account.address, RATE / BigInt(10), RATE * BigInt(10), BigInt(5) * one, BigInt(80_000)]);
ok("paymaster deployed (fork)", !!pm, pm);
const pmAbi = parseAbi(["function deposit() payable", "event GasPaid(address indexed sender, uint256 actualTokenCost, uint256 charged, uint256 debt)"]);
await pc.waitForTransactionReceipt({ hash: await dev.writeContract({ address: pm, abi: pmAbi, functionName: "deposit", value: parseEther("1") }) });
const policy = await deploy("DiscipleSessionPolicy.sol", "DiscipleSessionPolicy", [d.referralRegistry, pm]);
ok("session policy 1.4.0 deployed (fork)", !!policy, policy);

process.env.NEXT_PUBLIC_RHT_PAYMASTER = pm;
process.env.PAYMASTER_ADDRESS = pm;
process.env.PAYMASTER_RATE = RATE.toString();
// chains.ts already captured the paymaster env at import: patch the in-memory deployment (same object the app reads)
(d as { paymaster: Address }).paymaster = pm;

// in-process /api/bundler + /api/paymaster (the real route handlers)
const bundlerRoute = await import("../app/api/bundler/route");
const paymasterRoute = await import("../app/api/paymaster/route");
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const h = req.url?.startsWith("/api/paymaster") ? paymasterRoute.POST : bundlerRoute.POST;
  const r = await h(new Request(`${APP}${req.url}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" }, body: Buffer.concat(chunks) }));
  res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text());
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

const { Mav2Account } = await import("../lib/aa/mav2");
const { TRADE_PERMS, buildCreateSession, readSession } = await import("@disciple/session-keys");
const { getDefaultSingleSignerValidationModuleAddress, getDefaultTimeRangeModuleAddress } = await import("@account-kit/smart-contracts/experimental");
const { sessionPermissions, SESSION_POLICY_MODULE_ID, moduleIdAbi } = await import("../lib/aa/oneTap");
const { applySlippage } = await import("../lib/curveMath");
ok("policy moduleId 1.4.0", (await pc.readContract({ address: policy, abi: moduleIdAbi, functionName: "moduleId" })) === SESSION_POLICY_MODULE_ID);

const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const router = parseAbi([
  "function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)",
]);
void router;
const usdgOf = (a: Address) => pc.readContract({ address: d.usdg, abi: erc20, functionName: "balanceOf", args: [a] });
const usdgGas = { paymaster: pm, usdg: d.usdg, url: `${APP}/api/paymaster`, session: true };

const owner = privateKeyToAccount(generatePrivateKey());
const sa = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler`, usdgGas }, owner);
const me = await sa.address();
// fund the account with mUSDG only (test token: public mint), never ETH
await pc.waitForTransactionReceipt({ hash: await dev.writeContract({ address: d.usdg, abi: erc20, functionName: "mint", args: [me, BigInt(100) * one] }) });
ok("account holds 0 ETH", (await pc.getBalance({ address: me })) === BigInt(0));

// 1. owner op: deploy + mint STRATEGY, gas in USDG
let u0 = await usdgOf(me);
try {
  const r = await sa.sendCalls([{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("200")] }) }], "owner");
  const u1 = await usdgOf(me);
  ok("owner op (deploy + mint) paid in USDG", r.gasMode === "usdg" && u1 < u0, `${r.txHash} gas ${Number(u0 - u1) / Number(one)} USDG`);
  ok("ETH balance still 0", (await pc.getBalance({ address: me })) === BigInt(0));
  ok("paymaster allowance spent down (≤ dust)", (await pc.readContract({ address: d.usdg, abi: erc20, functionName: "allowance", args: [me, pm] })) < one);
} catch (e) { ok("owner op (deploy + mint) paid in USDG", false, (e as Error).message.slice(0, 300)); }

// 2. install session on policy 1.4.0 (owner op, USDG gas)
const key = generatePrivateKey();
const s = buildCreateSession({
  modules: { policy, singleSigner: getDefaultSingleSignerValidationModuleAddress(robinhoodTestnet), timeRange: getDefaultTimeRangeModuleAddress(robinhoodTestnet) },
  targets: { router: d.router, launchpad: d.launchpad, trampWallManager: d.trampWallManager },
  sessionSigner: privateKeyToAccount(key).address,
  caps: [{ token: d.defaultQuote, cap: parseEther("1000") }, { token: d.usdg, cap: BigInt(50) * one }],
  ttlSec: 86400, maxSlippageBps: 500, permissions: sessionPermissions(TRADE_PERMS, true),
});
try {
  const inst = await sa.sendCalls([{ to: me, data: s.data }], "owner");
  ok("owner installs session (USDG gas)", inst.gasMode === "usdg", inst.txHash);
  const info = await readSession(pc as never, policy, me, s.entityId);
  ok("session active", info.active);
  await sa.useSession(s.entityId, privateKeyToAccount(key));
} catch (e) { ok("owner installs session (USDG gas)", false, (e as Error).message.slice(0, 300)); }

// 3. session-key curve buy (v4 TRENCH smoke coin), gas in USDG
const { bondingCurveAbi, launchpadAbi } = await import("../lib/abi");
const coin = TESTNET_COINS.trench as Address;
u0 = await usdgOf(me);
try {
  const curve = await pc.readContract({ address: d.launchpad, abi: launchpadAbi, functionName: "curveOf", args: [coin] }) as Address;
  const qt = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" }) as Address;
  const amt = qt.toLowerCase() === d.usdg.toLowerCase() ? BigInt(5) * one : parseEther("10");
  if (qt.toLowerCase() !== d.usdg.toLowerCase()) await pc.waitForTransactionReceipt({ hash: await dev.writeContract({ address: qt, abi: erc20, functionName: "mint", args: [me, amt] }) });
  u0 = await usdgOf(me);
  const q = (await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quoteBuy", args: [amt] }) as { tokensOut: bigint }).tokensOut;
  const r = await sa.sendCalls([
    { to: qt, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [curve, amt] }) },
    { to: curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "buy", args: [amt, applySlippage(q, 450), BigInt(Math.floor(Date.now() / 1000) + 600)] }) },
  ], "session");
  const u1 = await usdgOf(me);
  const spent = qt.toLowerCase() === d.usdg.toLowerCase() ? u0 - u1 - amt : u0 - u1;
  ok("session curve buy paid in USDG", r.gasMode === "usdg" && spent > BigInt(0), `${r.txHash} gas ${Number(spent) / Number(one)} USDG`);
  ok("ETH balance still 0 after session op", (await pc.getBalance({ address: me })) === BigInt(0));
  ok("session buy received coin", (await pc.readContract({ address: coin, abi: erc20, functionName: "balanceOf", args: [me] })) > BigInt(0));
} catch (e) { ok("session curve buy paid in USDG", false, (e as Error).message.slice(0, 400)); }

// 4. fallback: paymaster unset ⇒ ETH prefund path ⇒ FundAccount (account has no ETH)
const saEth = new Mav2Account({ chain: robinhoodTestnet, pc: pc as never, bundlerUrl: `${APP}/api/bundler` }, owner);
try {
  await saEth.sendCalls([{ to: d.defaultQuote, data: encodeFunctionData({ abi: erc20, functionName: "mint", args: [me, parseEther("1")] }) }], "owner");
  ok("no paymaster ⇒ ETH prefund required", false, "unexpectedly succeeded");
} catch (e) { ok("no paymaster ⇒ ETH prefund required (FundAccount)", (e as { code?: string }).code === "FundAccount", (e as Error).message.slice(0, 160)); }

server.close(); stop();
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);

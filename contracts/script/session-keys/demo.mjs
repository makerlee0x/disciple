// MAv2 session-key demo on RH testnet 46630 via runtime validation (EOAs pay their own gas; no bundler/paymaster).
// Env: PRIVATE_KEY (deployer: STRATEGY mint + session-key gas), CREATOR_PRIVATE_KEY (account owner). Optional SALT, ENTITY, SESSION_PK.
import { accountFactoryAbi, semiModularAccountBytecodeAbi, serializeValidationConfig, serializeHookConfig, serializeModuleEntity } from "@account-kit/smart-contracts/experimental";
import { installValidationActions, getDefaultSingleSignerValidationModuleAddress, getDefaultAllowlistModuleAddress,
  getDefaultTimeRangeModuleAddress, SingleSignerValidationModule, AllowlistModule, TimeRangeModule, HookType } from "@account-kit/smart-contracts/experimental";
import { http, createPublicClient, createWalletClient, encodeFunctionData, concat, toHex, parseAbi, parseEther, toFunctionSelector, defineChain } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import fs from "node:fs";

const PUB = "https://rpc.testnet.chain.robinhood.com";
// bundler not used: runtime-validation path (EOA -> executeWithRuntimeValidation), see docs/session-keys.md
// const BUNDLER = `https://robinhood-testnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const chain = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [PUB] } } });
const pc = createPublicClient({ chain, transport: http(PUB) });
const ROUTER = "0xF70F50F8C89A62E47b9ffa8F47d368B6215168B9"; // DiscipleRouter (live v2)
const LAUNCHPAD = "0x5A3C7743D365F770710FE15F4bBf1cEc7bc41006";
const STRATEGY = "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3";
const TRMP = "0xfa86b94d37cba24910bd68426c5c0ace683d6628";
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)", "function transfer(address,uint256) returns (bool)"]);
const routerAbi = parseAbi(["function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)", "function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) returns (uint256)"]);
const out = { steps: [] };
const log = (k, v) => { console.log(k, v); out.steps.push([k, v]); };

const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const ownerAcc = privateKeyToAccount(process.env.CREATOR_PRIVATE_KEY);
const sessionPk = process.env.SESSION_PK ?? (fs.existsSync(".session.key") ? fs.readFileSync(".session.key", "utf8").trim() : generatePrivateKey());
fs.writeFileSync(".session.key", sessionPk, { mode: 0o600 }); // demo-only throwaway key, gitignored
const sessionAcc = privateKeyToAccount(sessionPk);
const sessionAddr = sessionAcc.address;
const ENTITY = Number(process.env.ENTITY ?? 8);
const EXEC_ENTITY = ENTITY + 2 ** 31; // separate Allowlist entity for the execution-phase ERC-20 spend limit (same convention as aa-sdk PermissionBuilder)
const LIMIT = parseEther("50");
const SALT = BigInt(process.env.SALT ?? 46630);
const ow = createWalletClient({ chain, transport: http(PUB), account: ownerAcc });
const sk = createWalletClient({ chain, transport: http(PUB), account: sessionAcc });
const dep = createWalletClient({ chain, transport: http(PUB), account: privateKeyToAccount(process.env.PRIVATE_KEY) });
const wait = async (h, k) => { const r = await pc.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(k + " reverted " + h); log(k, h); return r; };
const acct = await pc.readContract({ address: FACTORY, abi: accountFactoryAbi, functionName: "getAddressSemiModular", args: [ownerAcc.address, SALT] });
log("account", acct);
if ((await pc.getCode({ address: acct })) === undefined) await wait(await ow.writeContract({ address: FACTORY, abi: accountFactoryAbi, functionName: "createSemiModularAccount", args: [ownerAcc.address, SALT] }), "deployAccountTx");
if ((await pc.readContract({ address: STRATEGY, abi: erc20, functionName: "balanceOf", args: [acct] })) < parseEther("100"))
  await wait(await dep.writeContract({ address: STRATEGY, abi: erc20, functionName: "mint", args: [acct, parseEther("200")] }), "mintStrategyTx");
if ((await pc.getBalance({ address: sessionAddr })) < parseEther("0.00002"))
  await wait(await dep.sendTransaction({ to: sessionAddr, value: parseEther("0.00003") }), "fundSessionKeyGasTx");
// runtime authorization (ValidationLocatorLib): options(1: bit0=global) | entityId(4) | 0xFF final segment
// (no per-hook data; SingleSigner/SMA-fallback runtime auth is a msg.sender check)
const auth = (entityId, isGlobal) => concat([isGlobal ? "0x01" : "0x00", toHex(entityId, { size: 4 }), "0xFF"]);
const OWNER_AUTH = auth(0, true); // SMA fallback (owner) validation, entity 0
const SK_AUTH = auth(ENTITY, false);
const now = Math.floor(Date.now() / 1000);
const validUntil = now + 3600; // 1h session
const sel = (s) => toFunctionSelector(s);
// 1) owner installs the session key: SingleSigner validation (non-global, execute/executeBatch only)
//    + Allowlist pre-validation hook (targets/selectors + ERC-20 spend limit) + TimeRange (expiry).
const cfg = {
  validationConfig: { moduleAddress: getDefaultSingleSignerValidationModuleAddress(chain), entityId: ENTITY, isGlobal: false, isSignatureValidation: false, isUserOpValidation: true },
  selectors: [sel("execute(address,uint256,bytes)"), sel("executeBatch((address,uint256,bytes)[])")],
  installData: SingleSignerValidationModule.encodeOnInstallData({ entityId: ENTITY, signer: sessionAddr }),
  hooks: [
    { hookConfig: { address: getDefaultAllowlistModuleAddress(chain), entityId: ENTITY, hookType: HookType.VALIDATION, hasPreHooks: true, hasPostHooks: false },
      initData: AllowlistModule.encodeOnInstallData({ entityId: ENTITY, inputs: [
        { target: STRATEGY, hasSelectorAllowlist: true, hasERC20SpendLimit: false, erc20SpendLimit: 0n, selectors: [sel("approve(address,uint256)")] },
        { target: ROUTER, hasSelectorAllowlist: true, hasERC20SpendLimit: false, erc20SpendLimit: 0n, selectors: [sel("buyExactIn(address,uint256,uint256,address,uint256)"), sel("sellExactIn(address,uint256,uint256,address,uint256)")] },
      ] }) },
    // ERC-20 spend limits are enforced in the Allowlist *execution* hook, not the validation hook
    { hookConfig: { address: getDefaultAllowlistModuleAddress(chain), entityId: EXEC_ENTITY, hookType: HookType.EXECUTION, hasPreHooks: true, hasPostHooks: false },
      initData: AllowlistModule.encodeOnInstallData({ entityId: EXEC_ENTITY, inputs: [
        { target: STRATEGY, hasSelectorAllowlist: false, hasERC20SpendLimit: true, erc20SpendLimit: LIMIT, selectors: [] },
      ] }) },
    { hookConfig: { address: getDefaultTimeRangeModuleAddress(chain), entityId: ENTITY, hookType: HookType.VALIDATION, hasPreHooks: true, hasPostHooks: false },
      initData: TimeRangeModule.encodeOnInstallData({ entityId: ENTITY, validUntil, validAfter: 0 }) },
  ],
};
const installCall = encodeFunctionData({ abi: semiModularAccountBytecodeAbi, functionName: "installValidation", args: [
  serializeValidationConfig(cfg.validationConfig), cfg.selectors, cfg.installData,
  cfg.hooks.map((h) => concat([serializeHookConfig(h.hookConfig), h.initData])) ] });
const rt = (from, data, a) => ({ address: acct, abi: semiModularAccountBytecodeAbi, functionName: "executeWithRuntimeValidation", args: [data, a], account: from });
// 1) owner installs the session key (owner EOA pays its own gas)
await wait(await ow.writeContract(rt(ownerAcc, installCall, OWNER_AUTH)), "installSessionKeyTx");
// 2) session key: approve + buy TRMP via router, validated by SingleSigner(entity 7) + Allowlist + TimeRange hooks
const dl = BigInt(now + 600);
const buyAmt = parseEther("10");
const batch = (calls) => encodeFunctionData({ abi: semiModularAccountBytecodeAbi, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.target, value: 0n, data: c.data }))] });
const buy = batch([
  { target: STRATEGY, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, buyAmt] }) },
  { target: ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: "buyExactIn", args: [TRMP, buyAmt, 0n, acct, dl] }) },
]);
await wait(await sk.writeContract(rt(sessionAcc, buy, SK_AUTH)), "sessionKeyBuyTx");
log("TRMP balance", (await pc.readContract({ address: TRMP, abi: erc20, functionName: "balanceOf", args: [acct] })).toString());
// 3) negative checks (eth_call simulation, no gas)
async function expectReject(label, data, a = SK_AUTH, from = sessionAcc) {
  try { await pc.simulateContract(rt(from, data, a)); log(label, "UNEXPECTEDLY ALLOWED"); }
  catch (e) { log(label, "rejected: " + (e.shortMessage ?? e.message).toString().split("\n")[0].slice(0, 160)); }
}
await expectReject("negative: target not allowlisted (Launchpad)", batch([{ target: LAUNCHPAD, data: "0x12345678" }]));
await expectReject("negative: STRATEGY.transfer not allowlisted", batch([{ target: STRATEGY, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sessionAddr, 1n] }) }]));
await expectReject("negative: approve over remaining 40 STRATEGY spend limit", batch([{ target: STRATEGY, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, parseEther("45")] }) }]));
await expectReject("negative: random EOA using session entity", buy, SK_AUTH, privateKeyToAccount(generatePrivateKey()));
await expectReject("negative: session key calling installValidation", installCall);
fs.writeFileSync("result.json", JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

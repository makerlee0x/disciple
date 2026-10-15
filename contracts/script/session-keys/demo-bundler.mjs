// MAv2 session-key demo via ERC-4337 userOps (Alchemy bundler). Needs ALCHEMY_API_KEY; currently blocked: the key returns "Must be authenticated!".
// NOTE: spend limit must be an EXECUTION hook (see demo.mjs); this file still has the older validation-hook config.
import { createModularAccountV2Client, createModularAccountV2 } from "@account-kit/smart-contracts";
import { installValidationActions, getDefaultSingleSignerValidationModuleAddress, getDefaultAllowlistModuleAddress,
  getDefaultTimeRangeModuleAddress, SingleSignerValidationModule, AllowlistModule, TimeRangeModule, HookType } from "@account-kit/smart-contracts/experimental";
import { LocalAccountSigner, split } from "@aa-sdk/core";
import { http, createPublicClient, createWalletClient, encodeFunctionData, parseAbi, parseEther, toFunctionSelector, defineChain } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import fs from "node:fs";

const PUB = "https://rpc.testnet.chain.robinhood.com";
const BUNDLER = `https://robinhood-testnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const chain = defineChain({ id: 46630, name: "Robinhood Chain Testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [PUB] } } });
const transport = split({
  overrides: [{ methods: ["eth_sendUserOperation", "eth_estimateUserOperationGas", "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "eth_supportedEntryPoints", "rundler_maxPriorityFeePerGas"], transport: http(BUNDLER) }],
  fallback: http(PUB),
});
const pc = createPublicClient({ chain, transport: http(PUB) });
const ROUTER = "0xF70F50F8C89A62E47b9ffa8F47d368B6215168B9"; // DiscipleRouter (live v2)
const LAUNCHPAD = "0x5A3C7743D365F770710FE15F4bBf1cEc7bc41006";
const STRATEGY = "0xd4d0eB01960AACE441bFcb323Bfaf7c3d8b555a3";
const TRMP = "0xfa86b94d37cba24910bd68426c5c0ace683d6628";
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)", "function transfer(address,uint256) returns (bool)"]);
const routerAbi = parseAbi(["function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) returns (uint256)", "function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) returns (uint256)"]);
const out = { steps: [] };
const log = (k, v) => { console.log(k, v); out.steps.push([k, v]); };

const feeEstimator = async (struct) => {
  const blk = await pc.getBlock();
  const r = await fetch(BUNDLER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rundler_maxPriorityFeePerGas", params: [] }) }).then((x) => x.json());
  if (!r.result) throw new Error("rundler fee: " + JSON.stringify(r).slice(0, 200));
  const prio = BigInt(r.result);
  return { ...struct, maxPriorityFeePerGas: prio, maxFeePerGas: blk.baseFeePerGas * 2n + prio };
};

const ownerSigner = LocalAccountSigner.privateKeyToAccountSigner(process.env.CREATOR_PRIVATE_KEY);
const sessionPk = process.env.SESSION_PK ?? generatePrivateKey();
const sessionSigner = LocalAccountSigner.privateKeyToAccountSigner(sessionPk);
const sessionAddr = privateKeyToAccount(sessionPk).address;
const ENTITY = 7;
const LIMIT = parseEther("50"); // STRATEGY approve budget for the session key

const owner = (await createModularAccountV2Client({ chain, transport, signer: ownerSigner, feeEstimator, salt: BigInt(process.env.SALT ?? 46630) })).extend(installValidationActions);
const acct = owner.account.address;
log("account", acct);

// fund (deployer: tiny ETH for self-paid gas + mint test STRATEGY; owner of the test STRATEGY DevToken)
const dep = createWalletClient({ chain, transport: http(PUB), account: privateKeyToAccount(process.env.PRIVATE_KEY) });
if ((await pc.getBalance({ address: acct })) < parseEther("0.0001")) {
  const h = await dep.sendTransaction({ to: acct, value: parseEther("0.00025") }); await pc.waitForTransactionReceipt({ hash: h }); log("fundEthTx", h);
}
if ((await pc.readContract({ address: STRATEGY, abi: erc20, functionName: "balanceOf", args: [acct] })) < parseEther("100")) {
  const h = await dep.writeContract({ address: STRATEGY, abi: erc20, functionName: "mint", args: [acct, parseEther("200")] }); await pc.waitForTransactionReceipt({ hash: h }); log("mintStrategyTx", h);
}

const now = Math.floor(Date.now() / 1000);
const validUntil = now + 3600; // 1h session
const sel = (s) => toFunctionSelector(s);
// 1) owner installs the session key: SingleSigner validation (non-global, execute/executeBatch only)
//    + Allowlist pre-validation hook (targets/selectors + ERC-20 spend limit) + TimeRange (expiry).
const r1 = await owner.installValidation({
  validationConfig: { moduleAddress: getDefaultSingleSignerValidationModuleAddress(chain), entityId: ENTITY, isGlobal: false, isSignatureValidation: false, isUserOpValidation: true },
  selectors: [sel("execute(address,uint256,bytes)"), sel("executeBatch((address,uint256,bytes)[])")],
  installData: SingleSignerValidationModule.encodeOnInstallData({ entityId: ENTITY, signer: sessionAddr }),
  hooks: [
    { hookConfig: { address: getDefaultAllowlistModuleAddress(chain), entityId: ENTITY, hookType: HookType.VALIDATION, hasPreHooks: true, hasPostHooks: false },
      initData: AllowlistModule.encodeOnInstallData({ entityId: ENTITY, inputs: [
        { target: STRATEGY, hasSelectorAllowlist: true, hasERC20SpendLimit: true, erc20SpendLimit: LIMIT, selectors: [sel("approve(address,uint256)")] },
        { target: ROUTER, hasSelectorAllowlist: true, hasERC20SpendLimit: false, erc20SpendLimit: 0n, selectors: [sel("buyExactIn(address,uint256,uint256,address,uint256)"), sel("sellExactIn(address,uint256,uint256,address,uint256)")] },
      ] }) },
    { hookConfig: { address: getDefaultTimeRangeModuleAddress(chain), entityId: ENTITY, hookType: HookType.VALIDATION, hasPreHooks: true, hasPostHooks: false },
      initData: TimeRangeModule.encodeOnInstallData({ entityId: ENTITY, validUntil, validAfter: 0 }) },
  ],
});
const t1 = await owner.waitForUserOperationTransaction(r1);
log("installSessionKeyTx", t1);

// 2) session key client (same account, session-key validation entity)
const session = await createModularAccountV2Client({ chain, transport, signer: sessionSigner, feeEstimator, accountAddress: acct, signerEntity: { entityId: ENTITY, isGlobalValidation: false } });
const dl = BigInt(now + 600);
const buyAmt = parseEther("10");
const r2 = await session.sendUserOperation({ uo: [
  { target: STRATEGY, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, buyAmt] }) },
  { target: ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: "buyExactIn", args: [TRMP, buyAmt, 0n, acct, dl] }) },
] });
const t2 = await session.waitForUserOperationTransaction(r2);
log("sessionKeyBuyTx", t2);
log("TRMP balance", (await pc.readContract({ address: TRMP, abi: erc20, functionName: "balanceOf", args: [acct] })).toString());

// 3) negative checks (estimation only — no gas spent)
async function expectReject(label, uo) {
  try { await session.buildUserOperation({ uo }); log(label, "UNEXPECTEDLY ALLOWED"); }
  catch (e) { log(label, "rejected: " + (e.details ?? e.shortMessage ?? e.message).toString().slice(0, 160)); }
}
await expectReject("negative: target not allowlisted (Launchpad)", { target: LAUNCHPAD, data: "0x12345678" });
await expectReject("negative: STRATEGY.transfer not allowlisted", { target: STRATEGY, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [sessionAddr, 1n] }) });
await expectReject("negative: approve over remaining spend limit", { target: STRATEGY, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, parseEther("45")] }) });
fs.writeFileSync("result.json", JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

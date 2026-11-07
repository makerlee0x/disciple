/** Explicit testnet-only consolidation of EXISTING disposable fixtures. No USDG is minted/funded. */
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { accountFactoryAbi, semiModularAccountBytecodeAbi } from "@account-kit/smart-contracts/experimental";
import { robinhoodTestnet as chain } from "../lib/chains";
import { MAV2_FACTORY } from "../lib/aa/constants";
try {
if (process.env.SELF_BUNDLER_FIXTURE_PREP !== "1" || process.env.VERCEL_ENV || process.env.NODE_ENV === "production") throw Error("explicit local fixture prep required");
const pc = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }), cacheTime: 0 });
if (await pc.getChainId() !== 46630) throw Error("chain mismatch");
const file = "/workspace/self-bundler-lockdown-ledger.json";
const ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { priorUserOps: 21, newUserOpAttempts: 0, nativeTxAttempts: 0, transactions: [], maxTotal: 60 };
const save = () => writeFileSync(file, JSON.stringify(ledger, (_k,v) => typeof v === "bigint" ? v.toString() : v, 2));
if (ledger.transactions.length || ledger.nativeTxAttempts) throw Error("prep already attempted: reconcile ledger before any retry");
const keys = JSON.parse(readFileSync("/workspace/gasless-phase2-disposable-fixtures.json", "utf8")) as { owner: Hex }[];
const owners = keys.map((f: { owner: Hex }) => privateKeyToAccount(f.owner));
const accounts = await Promise.all(owners.map(o => pc.readContract({ address: MAV2_FACTORY, abi: accountFactoryAbi, functionName: "getAddressSemiModular", args: [o.address, 0n] })));
const expected = ["0x1f505cd8bd9af695d304e82eb4b24779106195ab", "0x64a9904b9dc4835c4a68b3fde7c84ed081afd941", "0x47954dc954801481a2c4c1a7a4bd16c6b9430764", "0xcea3a784df107b879203fbe78c86e25fffa58bd1", "0x4b9bd01dae35f9259bd17d2f5d04d1ec4f0d8143"];
if (accounts.some((a,i) => a.toLowerCase() !== expected[i])) throw Error("fixture identity mismatch");
const usdg = "0x9dc7a988a8707dc4ab7ac08fc2cb4d5bf906158d";
const abi = parseAbi(["function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"]);
const balance = (a: Address) => pc.readContract({ address: usdg, abi, functionName: "balanceOf", args: [a] });
const before = await Promise.all(accounts.map(balance));
if (before.map(String).join(",") !== "598010,950000,950000,950000,950000") throw Error("balances changed; recalculate before moving anything");
const plan = [{ i: 2, to: [{ address: accounts[0], amount: 950000n }] }, { i: 3, to: [{ address: accounts[0], amount: 650000n }, { address: accounts[1], amount: 300000n }] }, { i: 4, to: [{ address: accounts[1], amount: 950000n }] }];
const calls = (p: typeof plan[number]) => p.to.map(t => ({ target: usdg as Address, value: 0n, data: encodeFunctionData({ abi, functionName: "transfer", args: [t.address, t.amount] }) }));
// All account-owner runtime authorizations must pass before funding or sending anything.
for (const p of plan) await pc.simulateContract({ account: owners[p.i], address: accounts[p.i], abi: semiModularAccountBytecodeAbi, functionName: "executeBatch", args: [calls(p)] });
const key = process.env.PRIVATE_KEY as Hex;
if (!key) throw Error("inline sourced deployer key required");
const donor = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(undefined, { retryCount: 0 }) });
ledger.before = accounts.map((account,i) => ({ account, usdgRaw: String(before[i]) }));
const send = async (kind: string, metadata: object, fn: () => Promise<Hex>) => {
  if (ledger.priorUserOps + ledger.newUserOpAttempts + ledger.nativeTxAttempts >= 60) throw Error("total budget exhausted");
  ledger.nativeTxAttempts++; const r = { kind, ...metadata, submitCT: new Date().toLocaleString("sv-SE", { timeZone: "America/Chicago" }) + " CT", txHash: undefined as Hex | undefined, status: "attempting", gasCostWei: "" }; ledger.transactions.push(r); save();
  r.txHash = await fn(); r.status = "submitted"; save();
  const rc = await pc.waitForTransactionReceipt({ hash: r.txHash, pollingInterval: 100, timeout: 30000 }); r.status = rc.status; r.gasCostWei = String(rc.gasUsed * rc.effectiveGasPrice); save();
  if (rc.status !== "success") throw Error("fixture transaction reverted; no automatic retry");
};
for (const p of plan) {
  const owner = owners[p.i];
  if (await pc.getBalance({ address: owner.address }) < 5000000000000n) await send("ETH-for-owner-transfer-gas", { from: donor.account.address, to: owner.address, valueWei: "10000000000000" }, () => donor.sendTransaction({ to: owner.address, value: 10000000000000n }));
  const wallet = createWalletClient({ account: owner, chain, transport: http(undefined, { retryCount: 0 }) });
  await send("existing-USDG-consolidation", { from: accounts[p.i], transfers: p.to.map(t => ({ to: t.address, amountRaw: String(t.amount) })) }, () => wallet.writeContract({ address: accounts[p.i], abi: semiModularAccountBytecodeAbi, functionName: "executeBatch", args: [calls(p)] }));
}
const after = await Promise.all(accounts.map(balance));
if (after.reduce((a,b) => a+b,0n) !== before.reduce((a,b) => a+b,0n)) throw Error("USDG conservation failed");
ledger.after = accounts.map((account,i) => ({ account, usdgRaw: String(after[i]) })); save(); console.log(JSON.stringify({ nativeTxAttempts: ledger.nativeTxAttempts, totalUsed: 21 + ledger.nativeTxAttempts, after: ledger.after }));

} catch (e) { const x = e as { shortMessage?: string; message?: string }; console.error("fixture prep:", String(x.shortMessage || x.message || "failed").split("\n")[0].replace(/https?:\/\/[^\s]+/g, "[RPC URL REDACTED]")); process.exitCode = 1; }

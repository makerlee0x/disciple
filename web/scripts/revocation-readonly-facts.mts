/* eslint-disable @typescript-eslint/no-explicit-any -- one-off ops script, mirrors scripts/gasless-phase2.mts */
/* READ-ONLY. Derives addresses from keys in memory; prints addresses/state only (never keys). No signing, no sends. */
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
process.env.NEXT_PUBLIC_CHAIN_ID = "46630";
const { robinhoodTestnet: chain, DEPLOYMENTS } = await import("../lib/chains");
const { Mav2Account } = await import("../lib/aa/mav2");
const { readSession } = await import("@disciple/session-keys");
const POLICY = "0xD2cF85dd7cDC3c3e53EA0472BF6Bf006de45E4d2" as Address, EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const REAL = "0xf4C6B87aDBf4D762dfD104415B537b2cf5551109" as Address;
const pc = createPublicClient({ chain, transport: http(undefined, { timeout: 12000, retryCount: 0 }) });
const abi = parseAbi(["function paymaster() view returns(address)", "function verifiedUntil(address) view returns(uint64)", "function balanceOf(address) view returns(uint256)",
  "function creditOf(address) view returns(uint256)", "function reservedOf(address) view returns(uint256)", "function bootstrapUsed(address) view returns(bool)", "function availableCredit(address) view returns(uint256)"]);
const pm = await pc.readContract({ address: POLICY, abi, functionName: "paymaster" });
const d = DEPLOYMENTS[46630];
async function facts(account: Address, entity?: number) {
  const code = await pc.getCode({ address: account });
  const [usdg, credit, reserved, boot, login, eth] = await Promise.all([
    pc.readContract({ address: d.usdg, abi, functionName: "balanceOf", args: [account] }),
    pc.readContract({ address: pm, abi, functionName: "creditOf", args: [account] }).catch(() => null),
    pc.readContract({ address: pm, abi, functionName: "reservedOf", args: [account] }).catch(() => null),
    pc.readContract({ address: pm, abi, functionName: "bootstrapUsed", args: [account] }).catch(() => null),
    pc.readContract({ address: d.loginGate, abi, functionName: "verifiedUntil", args: [account] }),
    pc.getBalance({ address: account }),
  ]);
  const session = entity ? await readSession(pc as never, POLICY, account, entity).catch((e: Error) => ({ error: e.message.split("\n")[0] })) : undefined;
  const ownerInCode = code && code.length === 2 + 2 * (61 + 20) ? (`0x${code.slice(-40)}`) : undefined;
  return { account, deployed: !!code && code !== "0x", codeBytes: code ? (code.length - 2) / 2 : 0, ownerInCode, usdg: String(usdg), credit: String(credit), reserved: String(reserved), bootstrapUsed: boot, loginVerifiedUntil: String(login), ethWei: String(eth), session };
}
const block = await pc.getBlock();
const out: Record<string, unknown> = { readAtCT: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }), block: String(block.number), blockTs: String(block.timestamp), paymaster: pm };
out.real = await facts(REAL);
const fixtures = JSON.parse(readFileSync("/workspace/gasless-phase2-disposable-fixtures.json", "utf8")) as { owner: Hex; session: Hex; entityId: number }[];
out.fixtures = [];
for (const f of fixtures) {
  const owner = privateKeyToAccount(f.owner), signer = privateKeyToAccount(f.session);
  const sa = new Mav2Account({ chain, pc: pc as never, bundlerUrl: "http://localhost:0/none", bso: true, requireUsdgGas: true }, owner);
  const account = await sa.address();
  (out.fixtures as unknown[]).push({ ownerEOA: owner.address, sessionSigner: signer.address, entityId: f.entityId, ...(await facts(account, f.entityId)) });
}
const envOf = (p: string) => Object.fromEntries(readFileSync(p, "utf8").split("\n").filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const dep = envOf("/workspace/anypair/.secrets/testnet-deployer.env"), wal = envOf("/workspace/anypair/.secrets/testnet-wallets.env");
const controlled: { name: string; address: Address }[] = [];
for (const [k, v] of Object.entries({ ...dep, ...wal })) if (/PRIVATE_KEY$/.test(k) && /^(0x)?[0-9a-fA-F]{64}$/.test(v)) controlled.push({ name: k.replace(/_?PRIVATE_KEY$/, "") || "DEPLOYER", address: privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex).address });
out.controlledEOAs = controlled;
const realOwner = (out.real as { ownerInCode?: string }).ownerInCode?.toLowerCase();
out.realOwnerControlled = controlled.some(c => c.address.toLowerCase() === realOwner) || fixtures.some(f => privateKeyToAccount(f.owner).address.toLowerCase() === realOwner);
const depKey = dep.PRIVATE_KEY;
if (depKey) {
  const owner = privateKeyToAccount((depKey.startsWith("0x") ? depKey : `0x${depKey}`) as Hex);
  const sa = new Mav2Account({ chain, pc: pc as never, bundlerUrl: "http://localhost:0/none", bso: true, requireUsdgGas: true }, owner);
  out.deployerSmartAccount = { ownerEOA: owner.address, ownerEthWei: String(await pc.getBalance({ address: owner.address })), ...(await facts(await sa.address())) };
}
const text = JSON.stringify(out, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2);
if (/[0-9a-fA-F]{64}/.test(text.replace(/"0x[0-9a-fA-F]{40}"/g, ""))) throw Error("refusing to print: 32-byte hex found");
writeFileSync("/workspace/self-bundler-revocation/readonly-facts.json", text);
console.log(text);

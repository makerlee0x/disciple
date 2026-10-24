// Builds deployments json + web bundle from the forge broadcast/dry-run record.
// usage: node script/redeploy/postprocess.mjs <dry-run|fork|broadcast>
//   dry-run   → deployments/rh-testnet-46630.dry-run.json + ${path.relative(root, bdir)} (forge simulation, no chain)
//   fork      → deployments/fork/rh-testnet-46630.fork.json + deployments/fork/web-bundle (local anvil fork; not committed)
//   broadcast → deployments/rh-testnet-46630.json + ${path.relative(root, bdir)} (the real testnet redeploy)
import fs from "node:fs";
import path from "node:path";
const mode = process.argv[2] || "dry-run";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const rec = path.join(root, "broadcast/Deploy.s.sol/46630", mode === "dry-run" ? "dry-run" : "", "run-latest.json");
const run = JSON.parse(fs.readFileSync(rec, "utf8"));
const NAMES = ["ReferralRegistry", "LockedLP", "FeeRouter", "DiscipleHook", "Migration", "DiscipleRouter", "TrampWallManager",
  "AntiSnipe", "Launchpad", "QuotePricer", "QuoteProbe", "CurveDeployer", "RewardsVault", "AnonLauncher", "MarketLens", "UsdgDepositNotifier", "LoginGate"];
const contracts = {};
let gas = 0n;
const devTokens = {}; // DevToken creates: mock USDG (6-dec) and test STRATEGY, identified by symbol
for (const t of run.transactions) {
  gas += BigInt(t.transaction.gas);
  if (t.transactionType === "CREATE" && t.contractName === "DevToken") {
    const sym = (t.arguments ?? [])[1]?.replaceAll('"', "");
    if (sym && !devTokens[sym]) devTokens[sym] = { address: t.contractAddress, decimals: Number((t.arguments ?? [])[2]) };
  }
  if (t.transactionType?.startsWith("CREATE") && NAMES.includes(t.contractName) && !contracts[t.contractName])
    contracts[t.contractName] = t.contractAddress;
}
// CREATE2 hook deployments are recorded as CREATE2 via the deterministic deployer
for (const n of NAMES) if (!contracts[n]) console.warn("missing", n);
let cur = JSON.parse(fs.readFileSync(path.join(root, "deployments/rh-testnet-46630.json"), "utf8"));
// Re-run after a broadcast (e.g. to add SESSION_POLICY / PAYMASTER): rebuild from the stack we superseded, not ourselves.
if (cur.contracts?.Launchpad?.toLowerCase() === contracts.Launchpad?.toLowerCase() && cur.previous?.contracts) {
  const p = cur.previous;
  cur = { ...cur, id: p.id, startBlock: p.startBlock, contracts: p.contracts, addons: p.addons, smoke: p.smoke, previous: p.previous, tokens: cur.previousTokens ?? cur.tokens };
}
const gasUsed = (run.receipts ?? []).reduce((a, r) => a + BigInt(r.gasUsed ?? 0), 0n);
// Tokens: the run's DevTokens (fresh 6-dec mock USDG + test STRATEGY) or USDG / DEFAULT_QUOTE from env.
const tokens = {
  USDG: devTokens.USDG
    ? { address: devTokens.USDG.address, symbol: "USDG", decimals: devTokens.USDG.decimals, note: "mintable mock USDG (DevToken), 6 decimals like mainnet" }
    : { address: process.env.USDG, symbol: "USDG", decimals: Number(process.env.EXPECT_USDG_DECIMALS ?? 6) },
  STRATEGY: devTokens.STRATEGY
    ? { address: devTokens.STRATEGY.address, symbol: "STRATEGY", decimals: 18, note: "test STRATEGY; STRATEGY/USDG pricer pool fee 3000 / tickSpacing 60 / no hooks" }
    : { address: process.env.DEFAULT_QUOTE, symbol: "STRATEGY", decimals: 18 },
};
if (!tokens.USDG.address) console.warn("missing USDG address");
const next = {
  ...cur,
  deployedAt: new Date().toISOString().slice(0, 10),
  startBlock: mode === "dry-run" ? null : Number(BigInt(run.receipts?.[0]?.blockNumber ?? 0)),
  tokens: { ...cur.tokens, ...tokens },
  previousTokens: cur.tokens,
  id: "v" + (Number(String(cur.id ?? "v2").slice(1)) + 1),
  gitBranch: "main",
  deployCommit: process.env.DEPLOY_COMMIT ?? null,
  contracts: Object.fromEntries(NAMES.filter((n) => contracts[n]).map((n) => [n, contracts[n]])),
  hookTrustedRouters: [contracts.DiscipleRouter], // UR not trusted (audit #10 / SEC-05)
  previous: { id: cur.id ?? "v2", status: "superseded", supersededBy: "v" + (Number(String(cur.id ?? "v2").slice(1)) + 1), supersededAt: new Date().toISOString().slice(0, 10), note: "previous stack — superseded by combined redeploy", startBlock: cur.startBlock, contracts: cur.contracts, addons: cur.addons, smoke: cur.smoke, previous: cur.previous },
  estimatedGas: gas.toString(),
  gasUsed: mode === "dry-run" ? null : gasUsed.toString(),
};
delete next.addons; delete next.smoke;
// Post-core deploys (runbook step 4): SESSION_POLICY=0x… PAYMASTER=0x… node postprocess.mjs <mode> records them as addons
// (web/lib/aa/oneTap.ts reads addons.DiscipleSessionPolicy). Re-running postprocess is idempotent for the core stack.
const addons = {};
if (process.env.SESSION_POLICY) addons.DiscipleSessionPolicy = { address: process.env.SESSION_POLICY, version: process.env.SESSION_POLICY_VERSION ?? "1.4.0", constructor: { referralRegistry: contracts.ReferralRegistry, paymaster: process.env.PAYMASTER ?? null } };
if (process.env.PAYMASTER) addons.DisciplePaymaster = { address: process.env.PAYMASTER, entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" };
if (Object.keys(addons).length) next.addons = addons;
const outDir = path.join(root, "deployments", mode === "fork" ? "fork" : "");
fs.mkdirSync(outDir, { recursive: true });
const outJson = path.join(outDir, { broadcast: "rh-testnet-46630.json", fork: "rh-testnet-46630.fork.json" }[mode] ?? "rh-testnet-46630.dry-run.json");
fs.writeFileSync(outJson, JSON.stringify(next, null, 2) + "\n");
// web bundle
const bdir = path.join(outDir, "web-bundle");
fs.mkdirSync(path.join(bdir, "abi"), { recursive: true });
const abiFile = { DiscipleHook: "DiscipleHook", BondingCurve: "BondingCurve", Token: "Token" };
const abiNames = [...NAMES, "BondingCurve", "Token"];
let ts = `// AUTO-GENERATED by contracts/script/redeploy/postprocess.mjs (${mode}). Do not edit.\n`;
ts += `export const CHAIN_ID = 46630 as const;\nexport const START_BLOCK = ${next.startBlock ?? 0}n;\n`;
ts += `export const ADDRESSES = ${JSON.stringify({ ...next.contracts, ...next.uniswapV4, USDG: tokens.USDG.address, STRATEGY: tokens.STRATEGY.address }, null, 2)} as const;\n`;
ts += `export const PREVIOUS_ADDRESSES = ${JSON.stringify(cur.contracts, null, 2)} as const;\n`;
for (const n of abiNames) {
  const f = path.join(root, "out", `${abiFile[n] ?? n}.sol`, `${n}.json`);
  const abi = JSON.parse(fs.readFileSync(f, "utf8")).abi;
  fs.writeFileSync(path.join(bdir, "abi", `${n}.json`), JSON.stringify(abi, null, 2));
  ts += `export const ${n[0].toLowerCase() + n.slice(1)}Abi = ${JSON.stringify(abi)} as const;\n`;
}
fs.writeFileSync(path.join(bdir, "addresses.json"), JSON.stringify({ chainId: 46630, mode, startBlock: next.startBlock, contracts: next.contracts, previous: cur.contracts, uniswapV4: cur.uniswapV4, tokens: next.tokens }, null, 2) + "\n");
fs.writeFileSync(path.join(bdir, "index.ts"), ts);
console.log(`wrote ${path.relative(root, outJson)} + ${path.relative(root, bdir)} (${Object.keys(next.contracts).length} contracts, est gas ${gas}${mode === "dry-run" ? "" : `, gas used ${gasUsed}`})`);

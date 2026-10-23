// DisciplePaymaster deposit keeper (RH TESTNET only). Keeps the paymaster's EntryPoint v0.7 deposit — which fronts
// every USDG-gas op's ETH gas and is repaid in USDG to the treasury — between MIN and TARGET.
//
//   pnpm paymaster:keeper                 # dry run: print deposit / stake / keeper balance, send nothing
//   pnpm paymaster:keeper --send          # top up once if below PAYMASTER_MIN_DEPOSIT_WEI
//   pnpm paymaster:keeper --send --loop   # check every PAYMASTER_KEEPER_INTERVAL_SEC (default 60)
//
// Env: PAYMASTER_ADDRESS (or NEXT_PUBLIC_RHT_PAYMASTER), PAYMASTER_KEEPER_KEY (funded testnet EOA; only needed with
// --send; never printed), PAYMASTER_MIN_DEPOSIT_WEI (default 0.05 ETH), PAYMASTER_TARGET_DEPOSIT_WEI (default 0.2 ETH),
// PAYMASTER_KEEPER_RESERVE_WEI (left in the keeper for its own gas, default 0.01 ETH), RHT_RPC_URL (optional).
// Testnet: a plain top-up. Mainnet (later): also sweep treasury USDG → ETH on a schedule; out of scope here.
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 46630;
const RPC = process.env.RHT_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const chain = { id: CHAIN_ID, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const epAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function getDepositInfo(address) view returns ((uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime))",
]);
const pmAbi = parseAbi(["function deposit() payable", "function entryPoint() view returns (address)"]);

const args = new Set(process.argv.slice(2));
const SEND = args.has("--send"), LOOP = args.has("--loop");
const wei = (name: string, dflt: string) => { const v = process.env[name]; if (v && !/^\d+$/.test(v)) throw new Error(`${name} must be an integer (wei)`); return v ? BigInt(v) : parseEther(dflt); };
const MIN = wei("PAYMASTER_MIN_DEPOSIT_WEI", "0.05");
const TARGET = wei("PAYMASTER_TARGET_DEPOSIT_WEI", "0.2");
const RESERVE = wei("PAYMASTER_KEEPER_RESERVE_WEI", "0.01");
const INTERVAL = Math.max(15, Number(process.env.PAYMASTER_KEEPER_INTERVAL_SEC || 60)) * 1000;
const PM = (process.env.PAYMASTER_ADDRESS || process.env.NEXT_PUBLIC_RHT_PAYMASTER || "") as Address;
if (TARGET < MIN) throw new Error("PAYMASTER_TARGET_DEPOSIT_WEI must be >= PAYMASTER_MIN_DEPOSIT_WEI");

const pc = createPublicClient({ chain, transport: http(RPC) });

/** Pure decision (exported for tests): how much to deposit now. */
export function topUpAmount(deposit: bigint, keeperBal: bigint, min = MIN, target = TARGET, reserve = RESERVE): bigint {
  if (deposit >= min) return BigInt(0);
  const want = target - deposit, can = keeperBal > reserve ? keeperBal - reserve : BigInt(0);
  return want < can ? want : can;
}

async function once() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(PM)) throw new Error("set PAYMASTER_ADDRESS");
  const id = await pc.getChainId();
  if (id !== CHAIN_ID) throw new Error(`refusing: RPC chain ${id} is not RH testnet ${CHAIN_ID}`);
  const ep = await pc.readContract({ address: PM, abi: pmAbi, functionName: "entryPoint" });
  if (ep.toLowerCase() !== EP.toLowerCase()) throw new Error(`paymaster entryPoint ${ep} is not v0.7`);
  const [dep, info] = await Promise.all([
    pc.readContract({ address: EP, abi: epAbi, functionName: "balanceOf", args: [PM] }),
    pc.readContract({ address: EP, abi: epAbi, functionName: "getDepositInfo", args: [PM] }),
  ]);
  const key = process.env.PAYMASTER_KEEPER_KEY as Hex | undefined;
  const keeper = key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key) : undefined;
  const kbal = keeper ? await pc.getBalance({ address: keeper.address }) : BigInt(0);
  const amt = topUpAmount(dep, kbal);
  console.log(`[${new Date().toISOString()}] paymaster ${PM} deposit ${formatEther(dep)} ETH (min ${formatEther(MIN)}, target ${formatEther(TARGET)}); staked=${info.staked} stake=${formatEther(info.stake)} ETH delay=${info.unstakeDelaySec}s; keeper ${keeper ? `${keeper.address} ${formatEther(kbal)} ETH` : "(no PAYMASTER_KEEPER_KEY)"}`);
  if (!info.staked) console.warn("WARN: paymaster not staked — ERC-7562 bundlers may throttle it (DeployPaymaster.s.sol stakes it)");
  if (dep >= MIN) return;
  if (amt === BigInt(0)) { console.warn(`WARN: deposit below min and the keeper can't cover a top-up (fund ${keeper?.address ?? "the keeper"})`); return; }
  if (!SEND) { console.log(`dry run: would deposit ${formatEther(amt)} ETH (pass --send)`); return; }
  if (!keeper) throw new Error("--send needs PAYMASTER_KEEPER_KEY");
  const wc = createWalletClient({ chain, transport: http(RPC), account: keeper });
  const hash = await wc.writeContract({ address: PM, abi: pmAbi, functionName: "deposit", value: amt });
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
  console.log(`deposited ${formatEther(amt)} ETH: tx ${hash} ${rc.status}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    for (;;) {
      try { await once(); } catch (e) { console.error(`keeper error: ${(e as Error).message.split("\n")[0]}`); if (!LOOP) process.exit(1); }
      if (!LOOP) break;
      await new Promise((r) => setTimeout(r, INTERVAL));
    }
  })();
}

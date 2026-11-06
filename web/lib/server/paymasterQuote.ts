import "server-only";
/**
 * Real deps for the /api/paymaster quote rules (lib/server/paymasterCore): env config, the quote signer and chain
 * reads on RH testnet. Fails closed: no PAYMASTER_SIGNER_KEY / paymaster address / rate ⇒ PaymasterQuoteError("config").
 *
 * Env (server only — never NEXT_PUBLIC):
 *   PAYMASTER_SIGNER_KEY   0x-prefixed 32-byte key of DisciplePaymaster.signer. Never logged, never returned.
 *                          Must not be the relayer or faucet key. Unset ⇒ PVE_ATTESTER_PRIVATE_KEY (testnet: lee
 *                          2026-10-24, one key for login attest + paymaster). Must equal on-chain signer() (fail closed).
 *   PAYMASTER_ADDRESS      optional override of DEPLOYMENTS[46630].paymaster (NEXT_PUBLIC_RHT_PAYMASTER)
 *   PAYMASTER_RATE         USDG base units per 1 ETH (integer), or
 *   PAYMASTER_USD_PER_ETH  e.g. "3000" — scaled by USDG's on-chain decimals (18 on testnet, 6 on mainnet)
 *   PAYMASTER_QUOTE_TTL_SEC  optional, default 180 (contract max window 1h)
 *   PAYMASTER_MAX_SLACK_BPS  optional, default 5000 (approve may exceed the required amount by ≤ 50%)
 *   PAYMASTER_ALLOWANCE_TTL_SEC  optional, default 600: lifetime of a pre-issued per-sender allowance (pm_getPaymasterAllowance)
 * Mainnet (design only, not implemented): rate = 30-min TWAP of the USDG/WETH v3 pool via observe(), with the spot
 * price required within ±2% of the TWAP and the result clamped to the contract's [minRate, maxRate]; see
 * contracts/docs/usdg-paymaster.md §Pricing.
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet, DEPLOYMENTS } from "../chains";
import { disciplePaymasterAbi } from "../aa/paymaster";
import { launchTargets } from "../aa/launchTargets";
import { chainGradReads, isGradBuyOp } from "./gradBuy";
import { assertSignerMatches, unmarkedRate, PAYMASTER_CHAIN_ID, PaymasterQuoteError, paymasterSignerKey, rateFromEnv, type QuoteConfig, type QuoteDeps } from "./paymasterCore";

import { assertPrepaidReady } from "./prepaidPaymaster";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const clients = new Map<number, ReturnType<typeof createPublicClient>>();
function rpc(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    const chain = chainId === 4663 ? robinhood : robinhoodTestnet;
    c = createPublicClient({ chain, transport: http(undefined, { fetchOptions: { keepalive: true }, timeout: 3000, retryCount: 1 }) });
    clients.set(chainId, c);
  }
  return c;
}
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

let signer: PrivateKeyAccount | undefined;
let decimals: { usdg: Address; d: number } | undefined;
let boundsCache: { at: number; v: { minRate: bigint; maxRate: bigint; maxGasPerOp: bigint; maxLaunchGasPerOp: bigint } } | undefined;
let baseCache: { at: number; fee: bigint } | undefined;

function signerAccount(): PrivateKeyAccount {
  if (signer) return signer;
  return (signer = privateKeyToAccount(paymasterSignerKey({
    PAYMASTER_SIGNER_KEY: process.env.PAYMASTER_SIGNER_KEY, PVE_ATTESTER_PRIVATE_KEY: process.env.PVE_ATTESTER_PRIVATE_KEY,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY, DRIP_FAUCET_KEY: process.env.DRIP_FAUCET_KEY,
  }).key));
}

/** Checked once per paymaster address (cached only on success): local signer == DisciplePaymaster.signer(). */
let signerOk: Address | undefined;
async function checkSignerOnChain(paymaster: Address, chainId: number): Promise<void> {
  if (signerOk === paymaster) return;
  const onchain = await rpc(chainId).readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "signer" });
  assertSignerMatches(signerAccount().address, onchain);
  signerOk = paymaster;
}

export function paymasterAddress(chainId: number = PAYMASTER_CHAIN_ID): Address {
  const env = process.env.PAYMASTER_ADDRESS;
  const dep = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS]?.paymaster;
  const a = env && ADDR.test(env) ? (env as Address) : dep;
  if (!a || a === ZERO) throw new PaymasterQuoteError("config", "paymaster not deployed / configured");
  return a;
}

export async function quoteConfig(chainId: string | number = PAYMASTER_CHAIN_ID): Promise<QuoteConfig> {
  const id = Number(chainId);
  if (id !== 4663 && id !== 46630) throw new PaymasterQuoteError("chain", `unsupported chain ${id}`);
  const paymaster = paymasterAddress(id);
  signerAccount(); // fail closed before any RPC
  const usdg = DEPLOYMENTS[id as keyof typeof DEPLOYMENTS].usdg;
  try { await assertPrepaidReady(paymaster, undefined, { chainId: id, usdg }); } catch { throw new PaymasterQuoteError("config", "hardened prepaid USDG paymaster unavailable"); }
  await checkSignerOnChain(paymaster, id);
  if (!decimals || decimals.usdg !== usdg) decimals = { usdg, d: Number(await rpc(id).readContract({ address: usdg, abi: erc20, functionName: "decimals" })) };
  const ttl = Number(process.env.PAYMASTER_QUOTE_TTL_SEC || "");
  const slack = process.env.PAYMASTER_MAX_SLACK_BPS;
  const allowTtl = Number(process.env.PAYMASTER_ALLOWANCE_TTL_SEC || "");
  return {
    paymaster, usdg, usdgDecimals: decimals.d, rate: unmarkedRate(rateFromEnv({ PAYMASTER_RATE: process.env.PAYMASTER_RATE, PAYMASTER_USD_PER_ETH: process.env.PAYMASTER_USD_PER_ETH }, decimals.d)),
    ttlSec: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
    maxSlackBps: slack && /^\d+$/.test(slack) ? BigInt(slack) : undefined,
    allowanceTtlSec: Number.isFinite(allowTtl) && allowTtl > 0 ? allowTtl : undefined,
    launchers: launchTargets(id),
  };
}

export function quoteDeps(cfg: QuoteConfig, chainId: number = PAYMASTER_CHAIN_ID): QuoteDeps {
  const pc = rpc(chainId);
  return {
    now: () => Math.floor(Date.now() / 1000),
    debtOf: (s) => pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: "owedOf", args: [s] }),
    balanceOf: async (s) => {
      const [credit, reserved] = await Promise.all([
        pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: "creditOf", args: [s] }),
        pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: "reservedOf", args: [s] }),
      ]);
      return credit > reserved ? credit - reserved : BigInt(0);
    },
    allowanceOf: (s) => pc.readContract({ address: cfg.usdg, abi: erc20, functionName: "allowance", args: [s, cfg.paymaster] }),
    reservedOf: (s) => pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: "reservedOf", args: [s] }),
    bootstrapUsed: (s) => pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: "bootstrapUsed", args: [s] }),
    async bounds() {
      if (boundsCache && Date.now() - boundsCache.at < 60_000) return boundsCache.v;
      const [minRate, maxRate, maxGasPerOp, maxLaunchGasPerOp] = await Promise.all((["minRate", "maxRate", "maxGasPerOp", "maxLaunchGasPerOp"] as const).map((f) => pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: f })));
      boundsCache = { at: Date.now(), v: { minRate, maxRate, maxGasPerOp, maxLaunchGasPerOp } };
      return boundsCache.v;
    },
    async baseFee() {
      if (baseCache && Date.now() - baseCache.at < 2_000) return baseCache.fee;
      const fee = (await pc.getBlock()).baseFeePerGas ?? BigInt(0);
      baseCache = { at: Date.now(), fee };
      return fee;
    },
    sign: (hash) => signerAccount().signMessage({ message: { raw: hash } }),
    isGradBuy: (callData, sender) => isGradBuyOp(callData, sender, chainGradReads(pc as never, chainId, { paymaster: cfg.paymaster, usdg: cfg.usdg }), cfg.paymaster),
  };
}

/** Paymaster's EntryPoint deposit (wei) — the bundler refuses paymaster ops it can't cover. */
export async function paymasterDeposit(paymaster: Address): Promise<bigint> {
  return rpc(PAYMASTER_CHAIN_ID).readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "getDeposit" });
}

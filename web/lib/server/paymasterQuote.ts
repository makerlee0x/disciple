import "server-only";
/**
 * Real deps for the /api/paymaster quote rules (lib/server/paymasterCore): env config, the quote signer and chain
 * reads on RH testnet. Fails closed: no PAYMASTER_SIGNER_KEY / paymaster address / rate ⇒ PaymasterQuoteError("config").
 *
 * Env (server only — never NEXT_PUBLIC):
 *   PAYMASTER_SIGNER_KEY   0x-prefixed 32-byte key of DisciplePaymaster.signer. Never logged, never returned.
 *                          Must not be the relayer or faucet key.
 *   PAYMASTER_ADDRESS      optional override of DEPLOYMENTS[46630].paymaster (NEXT_PUBLIC_RHT_PAYMASTER)
 *   PAYMASTER_RATE         USDG base units per 1 ETH (integer), or
 *   PAYMASTER_USD_PER_ETH  e.g. "3000" — scaled by USDG's on-chain decimals (18 on testnet, 6 on mainnet)
 *   PAYMASTER_QUOTE_TTL_SEC  optional, default 180 (contract max window 1h)
 *   PAYMASTER_MAX_SLACK_BPS  optional, default 5000 (approve may exceed the required amount by ≤ 50%)
 * Mainnet (design only, not implemented): rate = 30-min TWAP of the USDG/WETH v3 pool via observe(), with the spot
 * price required within ±2% of the TWAP and the result clamped to the contract's [minRate, maxRate]; see
 * contracts/docs/usdg-paymaster.md §Pricing.
 */
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhoodTestnet, DEPLOYMENTS } from "../chains";
import { disciplePaymasterAbi } from "../aa/paymaster";
import { PAYMASTER_CHAIN_ID, PaymasterQuoteError, rateFromEnv, type QuoteConfig, type QuoteDeps } from "./paymasterCore";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true } }) });
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

let signer: PrivateKeyAccount | undefined;
let decimals: { usdg: Address; d: number } | undefined;
let boundsCache: { at: number; v: { minRate: bigint; maxRate: bigint; maxCostCap: bigint } } | undefined;
let baseCache: { at: number; fee: bigint } | undefined;

function signerAccount(): PrivateKeyAccount {
  if (signer) return signer;
  const k = process.env.PAYMASTER_SIGNER_KEY || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new PaymasterQuoteError("config", "paymaster signer not configured");
  const a = privateKeyToAccount(k as Hex);
  for (const other of [process.env.RELAYER_PRIVATE_KEY, process.env.DRIP_FAUCET_KEY]) {
    if (other && /^0x[0-9a-fA-F]{64}$/.test(other) && privateKeyToAccount(other as Hex).address === a.address)
      throw new PaymasterQuoteError("config", "paymaster signer must be a dedicated key (not the relayer / faucet key)");
  }
  return (signer = a);
}

export function paymasterAddress(): Address {
  const env = process.env.PAYMASTER_ADDRESS;
  const a = env && ADDR.test(env) ? (env as Address) : DEPLOYMENTS[PAYMASTER_CHAIN_ID].paymaster;
  if (!a || a === ZERO) throw new PaymasterQuoteError("config", "paymaster not deployed / configured");
  return a;
}

export async function quoteConfig(): Promise<QuoteConfig> {
  const paymaster = paymasterAddress();
  signerAccount(); // fail closed before any RPC
  const usdg = DEPLOYMENTS[PAYMASTER_CHAIN_ID].usdg;
  if (!decimals || decimals.usdg !== usdg) decimals = { usdg, d: Number(await pc.readContract({ address: usdg, abi: erc20, functionName: "decimals" })) };
  const ttl = Number(process.env.PAYMASTER_QUOTE_TTL_SEC || "");
  const slack = process.env.PAYMASTER_MAX_SLACK_BPS;
  return {
    paymaster, usdg, usdgDecimals: decimals.d, rate: rateFromEnv({ PAYMASTER_RATE: process.env.PAYMASTER_RATE, PAYMASTER_USD_PER_ETH: process.env.PAYMASTER_USD_PER_ETH }, decimals.d),
    ttlSec: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
    maxSlackBps: slack && /^\d+$/.test(slack) ? BigInt(slack) : undefined,
  };
}

export function quoteDeps(cfg: QuoteConfig): QuoteDeps {
  return {
    now: () => Math.floor(Date.now() / 1000),
    debtOf: (s) => pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: "debtOf", args: [s] }),
    balanceOf: (s) => pc.readContract({ address: cfg.usdg, abi: erc20, functionName: "balanceOf", args: [s] }),
    async bounds() {
      if (boundsCache && Date.now() - boundsCache.at < 60_000) return boundsCache.v;
      const [minRate, maxRate, maxCostCap] = await Promise.all((["minRate", "maxRate", "maxCostCap"] as const).map((f) => pc.readContract({ address: cfg.paymaster, abi: disciplePaymasterAbi, functionName: f })));
      boundsCache = { at: Date.now(), v: { minRate, maxRate, maxCostCap } };
      return boundsCache.v;
    },
    async baseFee() {
      if (baseCache && Date.now() - baseCache.at < 2_000) return baseCache.fee;
      const fee = (await pc.getBlock()).baseFeePerGas ?? BigInt(0);
      baseCache = { at: Date.now(), fee };
      return fee;
    },
    sign: (hash) => signerAccount().signMessage({ message: { raw: hash } }),
  };
}

/** Paymaster's EntryPoint deposit (wei) — the bundler refuses paymaster ops it can't cover. */
export async function paymasterDeposit(paymaster: Address): Promise<bigint> {
  return pc.readContract({ address: paymaster, abi: disciplePaymasterAbi, functionName: "getDeposit" });
}

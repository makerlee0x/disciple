import "server-only";
/**
 * DisciplePaymaster's EntryPoint deposit as seen by the relay (self-bundler + fast path): cached for DEPOSIT_TTL_MS
 * and debited locally by each relayed op's max prefund until the next read (conservative, like relayTrust balances).
 * No automatic funding/keeper. The bundler refuses ops the existing deposit cannot cover.
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { robinhoodTestnet } from "../chains";
import { ENTRYPOINT_V07 } from "../aa/constants";

const DEPOSIT_TTL_MS = 10_000;
const epAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const pc = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { fetchOptions: { keepalive: true } }) });
let cache: { pm: string; bal: bigint; at: number } | undefined;
let inflight: Promise<bigint> | undefined;

/** Our paymaster (PAYMASTER_ADDRESS env, else DEPLOYMENTS[46630].paymaster); undefined ⇒ paymaster ops refused. */
export { configuredPrepaidPaymaster as allowedPaymaster } from "./prepaidPaymaster";

export async function paymasterDepositCached(pm: Address): Promise<bigint> {
  if (cache && cache.pm === pm.toLowerCase() && Date.now() - cache.at < DEPOSIT_TTL_MS) return cache.bal;
  return (inflight ??= pc.readContract({ address: ENTRYPOINT_V07, abi: epAbi, functionName: "balanceOf", args: [pm] })
    .then((bal) => { cache = { pm: pm.toLowerCase(), bal, at: Date.now() }; return bal; })
    .finally(() => { inflight = undefined; }));
}

/** A relayed paymaster op may consume up to its max prefund from the deposit: debit it until the next read. */
export function debitPaymasterDeposit(pm: Address, prefund: bigint) {
  if (cache && cache.pm === pm.toLowerCase()) cache.bal -= prefund;
}

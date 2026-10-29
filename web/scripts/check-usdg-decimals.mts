/**
 * Read-only (eth_call) guard for the 6-dec USDG switch: the active chain's config usdgDecimals must equal the token's
 * on-chain decimals(). Run before/after the testnet redeploy with the env Vercel will use, e.g.
 *   NEXT_PUBLIC_RHT_USDG=0x… NEXT_PUBLIC_RHT_USDG_DECIMALS=6 pnpm check:usdg-decimals
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { ACTIVE_CHAIN, deployment } from "../lib/chains";
import { checkUsdgDecimals } from "../lib/usdg";

const pc = createPublicClient({ chain: ACTIVE_CHAIN, transport: http() }) as PublicClient;
const r = await checkUsdgDecimals(pc);
console.log(`${ACTIVE_CHAIN.name} (${ACTIVE_CHAIN.id}) USDG ${deployment().usdg}: config ${r.config}, on-chain ${r.onchain} → ${r.ok ? "OK" : "MISMATCH"}`);
if (!r.ok) process.exit(1);

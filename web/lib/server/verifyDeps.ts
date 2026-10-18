import "server-only";
/** Production wiring for lib/server/verification: Upstash KV, Privy env, and on-chain creator/account lookups. */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { launchpadAbi } from "@/lib/abi";
import { ACTIVE_CHAIN, deployment } from "@/lib/chains";
import { MAV2_FACTORY } from "@/lib/aa/constants";
import { kv } from "./kv";
import { privyEnv, type PrivyUser } from "./privyAuth";
import type { Deps } from "./verification";

const factoryAbi = parseAbi(["function getAddressSemiModular(address owner, uint256 salt) view returns (address)"]);
const Z = "0x0000000000000000000000000000000000000000";
const pc = () => createPublicClient({ chain: ACTIVE_CHAIN, transport: http() });

export function verifyDeps(): Deps {
  return {
    store: kv(),
    privy: privyEnv(),
    adminEmails: process.env.ADMIN_EMAILS,
    async creatorOf(token) {
      try {
        const c = await pc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "creatorOf", args: [token as Address] });
        return c && c !== Z ? (c as string).toLowerCase() : null;
      } catch { return null; }
    },
    // linked wallets + the MAv2 smart account each owns (salt 0, the app's account: lib/aa/mav2)
    async accountsOf(u: PrivyUser) {
      const c = pc();
      const smart = await Promise.all(u.wallets.slice(0, 10).map((w) =>
        c.readContract({ address: MAV2_FACTORY, abi: factoryAbi, functionName: "getAddressSemiModular", args: [w as Address, BigInt(0)] }).then((a) => (a as string).toLowerCase()).catch(() => null)));
      return [...u.wallets, ...smart.filter((x): x is string => !!x)];
    },
  };
}

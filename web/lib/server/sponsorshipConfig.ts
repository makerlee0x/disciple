import "server-only";
import { ACTIVE_CHAIN } from "../chains";
import { serverSponsorshipMode } from "../aa/sponsorshipMode";
/** Public configuration only. No credentials, RPC URLs, addresses, or signer data. */
export function sponsorshipConfig() {
  return { chainId: ACTIVE_CHAIN.id, mode: ACTIVE_CHAIN.id === 46630 ? serverSponsorshipMode() : "hosted" };
}

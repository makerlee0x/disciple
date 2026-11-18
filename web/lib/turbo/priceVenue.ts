/**
 * The live BTC price Turbo's screens should draw: Lighter's own (the exchange real orders go to and the duel server
 * scores on) when the server says so, else null (the usual Hyperliquid feed). One read per page load.
 */
import { withBase } from "@/lib/base-path";

let venue: Promise<string | null> | null = null;
export function lighterPriceHost(): Promise<string | null> {
  venue ??= fetch(withBase("/api/lighter/price"))
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { host?: string | null } | null) => (j && typeof j.host === "string" && j.host ? j.host : null))
    .catch(() => null);
  return venue;
}

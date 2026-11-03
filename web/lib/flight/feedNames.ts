/** TRADES card names for the engine ('disciple:feednames'): lc address → "@username" | default call sign | short address. */
import { holderNameNow } from "./holderNames";

export function feedNameMap(addresses: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of addresses) if (/^0x[0-9a-fA-F]{40}$/.test(a)) m[a.toLowerCase()] = holderNameNow(a);
  return m;
}

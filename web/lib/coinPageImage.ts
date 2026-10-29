/**
 * Coin page header image (/coin/<token>). A direct /coin link has no ?icon=, so the page resolves the coin's own image
 * the same way the home list does (lib/events listLaunches): read the on-chain Launchpad.metaOf(token).imageURI, then
 * map that exact URI through the moderated-store allowlist (lib/coinImages moderatedSrcs → POST /api/image/resolve →
 * /api/image/<id>). Unmoderated / unknown / blocked URIs resolve to "" ⇒ PairArt letter placeholder.
 *
 * ?icon= stays as a fast first paint for launchpad links, but it is only a /api/image/<sha> store src (isStoreSrc) and
 * the verified stored image always wins once resolved: when the coin's own image resolves, ?icon= is ignored; when the
 * coin's on-chain image is not approved, ?icon= is ignored too (placeholder), so a crafted ?icon= cannot dress a coin
 * up with some other image. Only when the chain read itself fails (offline / RPC error) does ?icon= remain.
 * Isomorphic and dependency-injected (unit-tested in scripts/test-coin-page-image.mts).
 */
import { isStoreSrc, moderatedSrcs } from "./coinImages";

/** undefined = not resolved yet (or the read failed); "" = no approved stored image; else the store src. */
export type StoredImage = string | undefined;

export async function resolveCoinStoredImage(
  readImageURI: () => Promise<string>,
  resolve: (uris: string[]) => Promise<Map<string, string>> = moderatedSrcs,
): Promise<StoredImage> {
  let uri: string;
  try { uri = String((await readImageURI()) ?? ""); } catch { return undefined; }
  if (!uri) return "";
  try {
    const src = (await resolve([uri])).get(uri) ?? "";
    return isStoreSrc(src) ? src : "";
  } catch { return undefined; }
}

/** The src the header renders: the verified stored image first, then a store-gated ?icon= only while unresolved. */
export function pickCoinIcon(stored: StoredImage, queryIcon: string | null | undefined, demoIcon: string | null = null): string | null {
  if (stored !== undefined) return stored || demoIcon || null;
  return (isStoreSrc(queryIcon) ? (queryIcon as string) : null) || demoIcon || null;
}

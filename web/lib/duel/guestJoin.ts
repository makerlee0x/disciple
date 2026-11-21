import { parseCode } from "./rules";

/** A friend's duel code in the URL (?c=CODE) and no signed-in pilot on this device: the /duel path that joins it as a
 *  guest, with the same query (the challenger's ?ref= rides along). null = stay on /turbo/duel. */
export function guestJoinPath(search: string, signedIn: boolean): string | null {
  if (signedIn) return null;
  const q = search.startsWith("?") ? search : search ? `?${search}` : "";
  return parseCode(new URLSearchParams(q).get("c")) ? `/duel${q}` : null;
}

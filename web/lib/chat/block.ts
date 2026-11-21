/**
 * Players you blocked in coin chat (App Review 1.2). Kept on this device: a blocked sender's messages never render for you
 * in any coin's chat. `disciple:chatblock` tells open chat cards to re-read the list.
 */
const KEY = "disciple.chat.blocked.v1", EV = "disciple:chatblock";
const lc = (s: string) => s.toLowerCase();

export function blockedList(): string[] {
  try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").map(lc) : []; } catch { return []; }
}
function save(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(Array.from(new Set(list.map(lc))).slice(-500))); } catch { /* private mode: lasts this page only */ }
  try { dispatchEvent(new CustomEvent(EV)); } catch { /* */ }
}
export const blockUser = (addr: string) => save([...blockedList(), addr]);
export const unblockUser = (addr: string) => save(blockedList().filter((a) => a !== lc(addr)));
export const unblockAll = () => save([]);
export function onBlockedChange(fn: () => void): () => void { addEventListener(EV, fn); addEventListener("storage", fn); return () => { removeEventListener(EV, fn); removeEventListener("storage", fn); }; }

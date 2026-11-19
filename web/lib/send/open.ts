/** Open the Send sheet (components/send/SendHost) for a rocket bag or an item copy. No chain code here. */
import type { Copy, Item } from "@/lib/collection";

export type SendAsset =
  | { kind: "rocket"; coin: string; name: string; symbol: string; icon?: string; tokens: number; priceUsd: number }
  | { kind: "item"; item: Item; copy: Copy };

export const OPEN_SEND_EVENT = "disciple:open-send";
export function openSend(a: SendAsset) {
  try { window.dispatchEvent(new CustomEvent<SendAsset>(OPEN_SEND_EVENT, { detail: a })); } catch { /* ssr */ }
}

/** Open the Send sheet (components/send/SendHost) for a rocket bag. No chain code here. Items never send: market only. */

export type SendAsset = { kind: "rocket"; coin: string; name: string; symbol: string; icon?: string; tokens: number; priceUsd: number };

export const OPEN_SEND_EVENT = "disciple:open-send";
export function openSend(a: SendAsset) {
  try { window.dispatchEvent(new CustomEvent<SendAsset>(OPEN_SEND_EVENT, { detail: a })); } catch { /* ssr */ }
}

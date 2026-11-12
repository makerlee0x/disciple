/** Client side of /api/x (lib/xLink.ts has the flow). */
import { IS_STATIC_PREVIEW } from "./base-path";
import { signWalletMessage } from "./profile";
import { xConnectMessage, xDisconnectMessage, type XLinkStatus } from "./xLink";

const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
export const X_CHANGED_EVENT = "disciple:x-changed";

export async function fetchXLink(address: string | null | undefined): Promise<XLinkStatus> {
  if (IS_STATIC_PREVIEW || !isAddr(address)) return { enabled: false, link: null };
  try {
    const j = (await (await fetch(`/api/x?address=${address.toLowerCase()}`, { cache: "no-store" })).json()) as Partial<XLinkStatus>;
    return { enabled: !!j.enabled, link: j.link ?? null };
  } catch { return { enabled: false, link: null }; }
}

async function signed(address: string, msg: (a: string, n: string) => string) {
  const a = address.toLowerCase();
  const { nonce } = (await (await fetch(`/api/x?nonce=1&address=${a}`, { cache: "no-store" })).json()) as { nonce?: string };
  if (!nonce) throw new Error("Could not reach the server.");
  const s = await signWalletMessage(msg(a, nonce), a);
  if (!s) throw new Error("Signing was cancelled.");
  return { address: a, nonce, ...s };
}

/** Signs, then sends the browser to X. Resolves only on failure (on success the page navigates away). */
export async function startXLink(address: string, returnTo = location.pathname): Promise<{ ok: false; reason: string }> {
  try {
    const body = await signed(address, xConnectMessage);
    const r = (await (await fetch("/api/x/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, returnTo }) })).json()) as { ok?: boolean; url?: string; reason?: string };
    if (r.ok && r.url) { location.assign(r.url); return new Promise(() => {}); }
    return { ok: false, reason: r.reason || "Couldn't start X linking." };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Couldn't start X linking." };
  }
}

export async function unlinkX(address: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const body = await signed(address, xDisconnectMessage);
    const r = (await (await fetch("/api/x/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { ok?: boolean; reason?: string };
    if (r.ok) window.dispatchEvent(new Event(X_CHANGED_EVENT));
    return { ok: !!r.ok, reason: r.reason };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Couldn't unlink X." };
  }
}

/** Client side of /api/x (lib/xLink.ts has the flow). */
import { IS_STATIC_PREVIEW } from "./base-path";
import { signWalletMessage } from "./profile";
import { privyAccessToken, privyAccount, privyHooksNow } from "./aa/sessionState";
import { X_RESULT_COPY, xConnectMessage, xDisconnectMessage, type XLinkStatus } from "./xLink";

const isAddr = (a: string | null | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
export const X_CHANGED_EVENT = "disciple:x-changed";
/** detail: the line to show next to the X row ("X account linked." / why it failed). */
export const X_NOTE_EVENT = "disciple:x-note";

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

// ---------------------------------------------------------------- iPhone app: X through Privy (app/api/x/privy)

const PENDING_KEY = "disciple.xlink.pending";
const PENDING_TTL_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Store the link Privy verified (the player's Privy user has X linked) on this wallet. */
async function linkFromPrivy(address: string): Promise<{ ok: boolean; reason?: string }> {
  // right after the sign-in sheet the page has just reloaded: the wallet may need a moment before it can sign
  let body: Awaited<ReturnType<typeof signed>> | null = null;
  for (let i = 0; i < 15 && !body; i++) {
    try { body = await signed(address, xConnectMessage); } catch (e) { if (i === 14) return { ok: false, reason: e instanceof Error ? e.message : X_RESULT_COPY.error }; await sleep(1000); }
  }
  const token = await privyAccessToken();
  if (!token || !body) return { ok: false, reason: "Sign in again, then try Connect X." };
  try {
    const r = await fetch("/api/x/privy", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    if (!r.ok || !j.ok) return { ok: false, reason: j.reason || X_RESULT_COPY.error };
  } catch { return { ok: false, reason: X_RESULT_COPY.error }; }
  window.dispatchEvent(new Event(X_CHANGED_EVENT));
  return { ok: true };
}

/** Privy refused the X link (Connect X started it): drop the pending link and say why next to the X row. */
export function failPendingXLink(code: string): void {
  let pending = false;
  try { pending = !!sessionStorage.getItem(PENDING_KEY); sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  if (!pending) return;
  const taken = /linked_to_another_user|already/i.test(code);
  const cancelled = /exited|cancel|closed/i.test(code);
  window.dispatchEvent(new CustomEvent<string>(X_NOTE_EVENT, {
    detail: taken ? "That X account already has its own DISCIPLE sign-in, so it can't be added to this one." : cancelled ? X_RESULT_COPY.denied : X_RESULT_COPY.error,
  }));
}

let finishing = false;
/** Called by the Privy bridge once the signed-in user has X linked: finishes a Connect X the app started. No-op otherwise. */
export async function finishPendingXLink(): Promise<void> {
  if (finishing) return;
  let p: { address?: string; at?: number } | null = null;
  try { p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch { p = null; }
  if (!p?.address || !p.at || Date.now() - p.at > PENDING_TTL_MS) return;
  finishing = true;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  try {
    const r = await linkFromPrivy(p.address);
    window.dispatchEvent(new CustomEvent<string>(X_NOTE_EVENT, { detail: r.ok ? X_RESULT_COPY.linked : r.reason || X_RESULT_COPY.error }));
  } finally { finishing = false; }
}

/** Signs, then sends the browser to X. Resolves only on failure (on success the page navigates away). */
export async function startXLink(address: string, returnTo = location.pathname): Promise<{ ok: false; reason: string }> {
  // Link X through Privy (web and iPhone app): X is attached to the player's login (Google / email / Apple), Privy
  // verifies it with X, and /api/x/privy stores it on this wallet. In the app this opens iOS's sign-in sheet (shares
  // Safari's X login). Our own X developer app (/api/x/connect below) is the fallback only when Privy isn't there, or
  // when NEXT_PUBLIC_X_LINK_OWN_OAUTH=1 (maker 2026-11-16: the own-app link came back "Couldn't link your X account").
  // Already linked to the Privy account: just store it.
  const hooks = privyHooksNow();
  if (process.env.NEXT_PUBLIC_X_LINK_OWN_OAUTH !== "1" && hooks?.authenticated && hooks.linkX) {
    if (privyAccount()?.xUsername) {
      const r = await linkFromPrivy(address);
      return { ok: false, reason: r.ok ? X_RESULT_COPY.linked : r.reason || X_RESULT_COPY.error };
    }
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ address: address.toLowerCase(), at: Date.now() })); } catch { /* ignore */ }
    try { hooks.linkX(); } catch { return { ok: false, reason: X_RESULT_COPY.error }; }
    return { ok: false, reason: "" };
  }
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

"use client";
/** Client side of the invite API: every call carries the Privy session (no wallet signature). */
import { withBase } from "./base-path";
import { privyAccessToken, privyLogin, privyReady } from "./aa/session";

export class NeedLogin extends Error { code = "NeedLogin"; }
type Err = Error & { status?: number; code?: string };

async function call<T>(path: string, init?: RequestInit, optionalAuth = false): Promise<T> {
  const t = await privyAccessToken();
  if (!t && !optionalAuth) throw new NeedLogin("Sign in first.");
  const r = await fetch(withBase(path), { ...init, headers: { ...(init?.headers || {}), ...(t ? { authorization: `Bearer ${t}` } : {}), "content-type": "application/json" }, cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status, code: j.error }) as Err;
  return j;
}
export const loginPrivy = () => { if (privyReady()) privyLogin(); };

export type MyCode = { code: string; used: boolean };
export type InviteStatus = { mode: boolean; signedIn?: boolean; in?: boolean; admin?: boolean; waitlisted?: boolean; left?: number; codes?: MyCode[] };
export const inviteStatus = () => call<InviteStatus>("/api/invites", undefined, true);
export const redeemInvite = (code: string) => call<{ ok: boolean }>("/api/invites", { method: "POST", body: JSON.stringify({ action: "redeem", code }) });
export const joinWaitlist = () => call<{ ok: boolean }>("/api/invites", { method: "POST", body: JSON.stringify({ action: "waitlist" }) });
export const inviteLink = (code: string) => `${typeof window !== "undefined" ? window.location.origin : ""}${withBase(`/i/${code}`)}`;

/** A code from an /i/<CODE> link, kept until it's used. */
const PENDING = "disciple:invite-code";
export const savePendingCode = (c: string) => { try { localStorage.setItem(PENDING, c); } catch { /* private mode */ } };
export const pendingCode = () => { try { return localStorage.getItem(PENDING) || ""; } catch { return ""; } };
export const clearPendingCode = () => { try { localStorage.removeItem(PENDING); } catch { /* private mode */ } };

export type AdminCode = { code: string; by: string; createdAt: number; usedBy?: string; usedAt?: number; revoked?: boolean };
export type AdminData = { me: string | null; mode: boolean; modeSource: "kv" | "env" | "default"; envDefault: boolean; codes: AdminCode[]; waitlist: { privyId: string; at: number }[]; log: Record<string, unknown>[] };
export const adminInvites = () => call<AdminData>("/api/admin/invites");
export async function adminInviteDo(body: Record<string, unknown>) {
  const { nonce } = await call<{ nonce: string }>("/api/admin/invites?nonce=1");
  return call<{ ok: boolean; codes?: string[]; mode?: boolean; already?: boolean }>("/api/admin/invites", { method: "POST", body: JSON.stringify({ ...body, nonce }) });
}

"use client";
/** Client side of the verification review API: every call carries the Privy session (no wallet signature). */
import { withBase } from "../base-path";
import { privyAccessToken, privyLogin, privyReady } from "../aa/session";

export class NeedLogin extends Error { code = "NeedLogin"; }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await privyAccessToken();
  if (!t) throw new NeedLogin("Log in with email or Google first.");
  const r = await fetch(withBase(path), { ...init, headers: { ...(init?.headers || {}), authorization: `Bearer ${t}`, "content-type": "application/json" }, cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status });
  return j;
}
export const loginPrivy = () => { if (privyReady()) privyLogin(); };

export type MyRequest = { status: "pending" | "approved" | "rejected" | "revoked" | null; reason?: string | null; x?: string | null; website?: string | null; note?: string };
export const myVerification = (token: string) => call<MyRequest>(`/api/verify?token=${token}`);
export async function requestVerification(f: { token: string; x: string; website: string; note: string }) {
  const { nonce } = await call<{ nonce: string }>("/api/verify?nonce=1");
  return call<{ ok: boolean; status: string }>("/api/verify", { method: "POST", body: JSON.stringify({ ...f, nonce }) });
}

export type AdminRow = { token: string; creator: string; x: string | null; website: string | null; note: string; status: string; requestedAt: number; updatedAt: number; reviewedBy?: string; reason?: string };
export const adminRows = (status: string) => call<{ me: string | null; rows: AdminRow[] }>(`/api/admin/verifications?status=${encodeURIComponent(status)}`);
export async function adminDo(token: string, action: "approve" | "reject" | "revoke", reason?: string) {
  const { nonce } = await call<{ nonce: string }>("/api/admin/verifications?nonce=1");
  return call<{ ok: boolean; status: string }>("/api/admin/verifications", { method: "POST", body: JSON.stringify({ token, action, nonce, reason }) });
}

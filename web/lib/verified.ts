"use client";
/**
 * Verified badge state for rockets: admin-approved ONLY (GET /api/verified, lib/server/verification). Batches lookups
 * from every card on screen into one request per tick; sample/mock coins (non-addresses) are never verified.
 */
import { useEffect, useState } from "react";
import { withBase } from "./base-path";

const known = new Map<string, boolean>();
const waiting = new Set<string>();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
const isAddr = (t: string) => /^0x[0-9a-fA-F]{40}$/.test(t);

function flush() {
  timer = null;
  const batch = Array.from(waiting).slice(0, 100);
  batch.forEach((t) => waiting.delete(t));
  if (waiting.size) timer = setTimeout(flush, 0);
  if (!batch.length) return;
  fetch(withBase(`/api/verified?tokens=${batch.join(",")}`))
    .then((r) => (r.ok ? r.json() : { verified: {} }))
    .catch(() => ({ verified: {} }))
    .then((j: { verified?: Record<string, true> }) => {
      for (const t of batch) known.set(t, !!j.verified?.[t]);
      subs.forEach((f) => f());
    });
}

/** Is this rocket verified (admin-approved)? false until known. */
export function useVerified(token: string | null | undefined): boolean {
  const t = (token || "").toLowerCase();
  const [, bump] = useState(0);
  useEffect(() => {
    if (!isAddr(t)) return;
    const f = () => bump((n) => n + 1);
    subs.add(f);
    if (!known.has(t)) { waiting.add(t); if (!timer) timer = setTimeout(flush, 30); }
    return () => { subs.delete(f); };
  }, [t]);
  return isAddr(t) && known.get(t) === true;
}
/** Sync read of an already-fetched verdict (filters). */
export const isVerifiedKnown = (token: string) => known.get(token.toLowerCase()) === true;
/** Re-read after an admin action. */
export function invalidateVerified(token?: string) { if (token) known.delete(token.toLowerCase()); else known.clear(); }
export function onVerifiedChange(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }

/** Verified subset of `ids` (e.g. for the launchpad "Verified" filter); requests unknown ones in batches. */
export function useVerifiedMany(ids: string[]): Set<string> {
  const key = ids.filter(isAddr).map((t) => t.toLowerCase()).sort().join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const ts = key ? key.split(",") : [];
    const f = () => bump((n) => n + 1);
    subs.add(f);
    let any = false;
    for (const t of ts) if (!known.has(t)) { waiting.add(t); any = true; }
    if (any && !timer) timer = setTimeout(flush, 30);
    return () => { subs.delete(f); };
  }, [key]);
  return new Set(key ? key.split(",").filter((t) => known.get(t) === true) : []);
}

"use client";
/**
 * Invite (maker 2026-11-18: "i dont see ref codes at all"): one action for the Invite buttons on the profile and in the
 * account menu. Phones get the share sheet; desktop copies the /r/<name> link.
 */
import { localUsername, referralUrl } from "@/lib/profile";

export const INVITE_TEXT = "Fly with me on DISCIPLE";

export async function shareInvite(wallet: string | null, username?: string | null): Promise<"shared" | "copied" | "failed"> {
  const url = referralUrl(username || localUsername() || null, wallet);
  const phone = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  if (phone && typeof navigator !== "undefined" && navigator.share) {
    try { await navigator.share({ text: INVITE_TEXT, url }); return "shared"; }
    catch (e) { if ((e as Error)?.name === "AbortError") return "failed"; }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; } catch { return "failed"; }
}

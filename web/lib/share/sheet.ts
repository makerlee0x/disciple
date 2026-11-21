/**
 * One way to share a win from a phone (maker 2026-11-21, "make phone wins easy to share"):
 *   - every shared link carries the sharer as ?r= (maker 2026-11-17: shares carry the sharer's ref link)
 *   - the native share sheet gets the win card or clip as a file when the phone can take it, else text + link
 *   - no share sheet (desktop Firefox, old browsers): the post text and link go to the clipboard
 *   - Save inside the iPhone app opens the share sheet (it has Save Image / Save Video): the app's web view has no
 *     downloads, so a download link there does nothing
 * Pure helpers (withSharerRef, sharePayload) are tested in scripts/test-native.mts.
 */
import { isNativeApp } from "@/lib/native";

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Our share hosts. A link anywhere else is returned unchanged (never tag someone else's site). */
const OURS = /(^|\.)disciple\.vip$|^localhost$|^127\.0\.0\.1$|\.vercel\.app$/;

/**
 * A DISCIPLE link with the sharer as ?r=<username> (wallet until a username exists). A link that already names a
 * referrer (?r= or ?ref=) keeps it: a /vs/<pilot> challenge already points at its own pilot.
 */
export function withSharerRef(url: string, username: string | null | undefined, wallet?: string | null): string {
  const r = username ? username.toLowerCase().replace(/^@/, "") : isAddr(wallet) ? wallet.toLowerCase() : "";
  if (!r || !/^(0x[0-9a-f]{40}|[a-z0-9_]{1,32})$/.test(r)) return url;
  try {
    const u = new URL(url);
    if (!OURS.test(u.hostname) || u.searchParams.has("r") || u.searchParams.has("ref")) return url;
    u.searchParams.set("r", r);
    return u.toString();
  } catch { return url; }
}

export interface ShareInput { text: string; url: string; file?: File | null; title?: string }

/**
 * What goes to navigator.share. With a file the link rides in the text: iOS drops the file for some apps when a
 * separate url is passed, and X/iMessage keep the text.
 */
const withLink = (p: ShareInput) => (p.text.includes(p.url) ? p.text : `${p.text} ${p.url}`.trim());
export function sharePayload(p: ShareInput, canShareFiles: boolean): ShareData {
  if (p.file && canShareFiles) return { files: [p.file], text: withLink(p), ...(p.title ? { title: p.title } : {}) };
  return { text: p.text, url: p.url, ...(p.title ? { title: p.title } : {}) };
}

type Nav = Navigator & { canShare?: (d: ShareData) => boolean };
const nav = (): Nav | null => (typeof navigator === "undefined" ? null : (navigator as Nav));
export const canShareFile = (f: File | null | undefined) => { const n = nav(); try { return !!(f && n?.share && n.canShare?.({ files: [f] })); } catch { return false; } };

export type ShareResult = "shared" | "cancelled" | "copied" | "failed";

/** Open the share sheet (card file + text + ref link); falls back to copying the post. */
export async function openShareSheet(p: ShareInput): Promise<ShareResult> {
  const n = nav();
  if (n?.share) {
    try { await n.share(sharePayload(p, canShareFile(p.file))); return "shared"; }
    catch (e) {
      if ((e as Error)?.name === "AbortError") return "cancelled";
      // a file the target refused: try once more without it
      if (p.file) { try { await n.share(sharePayload({ ...p, file: null }, false)); return "shared"; } catch (e2) { if ((e2 as Error)?.name === "AbortError") return "cancelled"; } }
    }
  }
  try { await n?.clipboard.writeText(withLink(p)); return "copied"; } catch { return "failed"; }
}

/** Save the card or clip. In the iPhone app that means the share sheet (Save Image / Save Video live there). */
export async function saveShareFile(file: File): Promise<"saved" | "shared" | "cancelled" | "failed"> {
  if (isNativeApp() && canShareFile(file)) {
    try { await nav()!.share({ files: [file] }); return "shared"; } catch (e) { return (e as Error)?.name === "AbortError" ? "cancelled" : "failed"; }
  }
  try {
    const u = URL.createObjectURL(file), a = document.createElement("a");
    a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
    return "saved";
  } catch { return "failed"; }
}

/** A canvas → a shareable file (JPEG keeps the X upload small). */
export function canvasFile(cv: HTMLCanvasElement, name: string, type = "image/jpeg"): Promise<File | null> {
  return new Promise((res) => {
    try { cv.toBlob((b) => res(b ? new File([b], name, { type }) : null), type, 0.9); } catch { res(null); }
  });
}

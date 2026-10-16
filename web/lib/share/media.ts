/**
 * Share media abstraction: PNG from /api/share/card (imageMedia) or an MP4/WebM rendered in the browser from the
 * deterministic replay + end card (lib/share/video.ts → videoMedia). ShareModal shares/downloads either unchanged.
 */
export interface ShareParams { wallet: string | null; coin: string; ticker?: string; username?: string | null; demo?: boolean; at?: number; loadout?: { skin: string; coin: string; thruster: string } }
export interface ShareMedia {
  kind: "image" | "video";
  mime: string;
  filename: string;
  /** preview src for <img>/<video> */
  url: string;
  blob(): Promise<Blob>;
}
export function cardQuery(p: ShareParams, format: "story" | "og") {
  const q = new URLSearchParams({ coin: p.coin, format });
  if (p.wallet) q.set("wallet", p.wallet);
  if (p.ticker) q.set("ticker", p.ticker);
  if (p.username) q.set("username", p.username);
  if (p.demo) q.set("demo", "1");
  if (p.at) q.set("at", String(p.at));
  if (p.loadout) { q.set("skin", p.loadout.skin); q.set("nose", p.loadout.coin); q.set("thruster", p.loadout.thruster); }
  return q.toString();
}
export function imageMedia(p: ShareParams, format: "story" | "og" = "story"): ShareMedia {
  const url = `/api/share/card?${cardQuery(p, format)}`;
  let cached: Promise<Blob> | null = null;
  return {
    kind: "image", mime: "image/png", url,
    filename: `disciple-${(p.ticker || "trade").toLowerCase()}-${format}.png`,
    blob: () => (cached ??= fetch(url).then((r) => { if (!r.ok) throw new Error(`card ${r.status}`); return r.blob(); })),
  };
}
/** Single entry point the modal uses; swap the body for a video producer later. */
export function shareMediaFor(p: ShareParams): ShareMedia { return imageMedia(p, "story"); }

/** Wrap an encoded video as ShareMedia (same interface as the PNG, so the modal shares/downloads it unchanged). */
export function videoMedia(blob: Blob, mime: string, ext: string, ticker?: string): ShareMedia {
  return { kind: "video", mime, url: URL.createObjectURL(blob), filename: `disciple-${(ticker || "trade").toLowerCase()}.${ext}`, blob: async () => blob };
}
/** Is a video render possible here at all? (replay hook is checked lazily in lib/share/video.getReplay) */
export function canEncodeVideo(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder !== "undefined" || typeof MediaRecorder !== "undefined";
}

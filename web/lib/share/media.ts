/**
 * Share media abstraction. Today: a static PNG from /api/share/card. When GAME ships a deterministic replay hook,
 * add a `kind: "video"` producer here (same params) and ShareModal will share/download it unchanged.
 */
export interface ShareParams { wallet: string | null; coin: string; ticker?: string; username?: string | null; demo?: boolean; at?: number }
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

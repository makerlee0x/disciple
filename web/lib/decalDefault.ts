/**
 * Generated house badge for Quick Launch (r4: generated default images are allowed).
 *
 * Mirrors the mockup generator at disciple-brand/mockups/quick-launch-r4/src/decal.py:
 * ticker monogram on a sky-indigo disc, lavender ring, pearl sigil, no gold.
 * Rendered to a 512px PNG data URI on the client so the launch path can store it
 * the same way an upload is stored (lib/launchImage — absolute URL, not a data: URI).
 */
export const DECAL_SIZE = 512;
const INK = "#202141";
const RING = "#8585aa";
const TEXT = "#E8EAEE";
const SIGIL = "#BCC0CA";

/** Letters drawn on the badge (ticker, uppercased, max 8). */
export function badgeLetters(ticker: string): string {
  const t = ticker.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (t || "?").slice(0, 8);
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (-90 + i * 45) * Math.PI / 180;
    const rad = i % 2 === 0 ? r : r * 0.38;
    const x = cx + rad * Math.cos(a);
    const y = cy + rad * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Draw the 512px badge onto a canvas (browser only). */
export function drawHouseBadge(ctx: CanvasRenderingContext2D, size: number, ticker: string) {
  const letters = badgeLetters(ticker);
  ctx.clearRect(0, 0, size, size);
  const m = 8;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, (size - 2 * m) / 2, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
  const pad = Math.round(size * 0.07);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, (size - 2 * (m + pad)) / 2, 0, Math.PI * 2);
  ctx.strokeStyle = RING;
  ctx.lineWidth = Math.max(2, size / 64);
  ctx.stroke();
  ctx.fillStyle = SIGIL;
  starPath(ctx, size / 2, size * 0.28, size * 0.08);
  ctx.fill();
  const fontSize = Math.round(size * (letters.length <= 3 ? 0.28 : letters.length === 4 ? 0.22 : 0.18));
  ctx.font = `650 ${fontSize}px Geist, system-ui, sans-serif`;
  ctx.fillStyle = TEXT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letters, size / 2, size * 0.58);
}

/** 512px PNG data URI, or null when canvas isn't available (SSR / tests). */
export function houseBadgeDataUri(ticker: string, size = DECAL_SIZE): string | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  drawHouseBadge(ctx, size, ticker);
  return c.toDataURL("image/png");
}

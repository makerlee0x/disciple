"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Square-only crop: the image covers a square frame; drag to reposition. No zoom. */
export function cropSquare(img: HTMLImageElement, pos: { x: number; y: number }, size = 256): string {
  const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h);
  const sx = (w - side) * pos.x, sy = (h - side) * pos.y;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  c.getContext("2d")!.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  const webp = c.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
}

export default function SquareCrop({ img, pos, onChange, size = 220 }: {
  img: HTMLImageElement; pos: { x: number; y: number }; onChange: (p: { x: number; y: number }) => void; size?: number;
}) {
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [grab, setGrab] = useState(false);
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = size / Math.min(w, h);
  const dw = w * scale, dh = h * scale; // displayed size (cover)
  const ox = (size - dw) * pos.x, oy = (size - dh) * pos.y;
  const movable = dw > size + 1 || dh > size + 1;

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const nx = dw > size ? d.x - (e.clientX - d.px) / (dw - size) : 0.5;
    const ny = dh > size ? d.y - (e.clientY - d.py) / (dh - size) : 0.5;
    onChange({ x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) });
  }, [dw, dh, size, onChange]);
  useEffect(() => {
    const up = () => { drag.current = null; setGrab(false); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", up); };
  }, [onMove]);

  return (
    <div
      className={`sq-crop ${grab ? "grab" : ""}`}
      style={{ width: size, height: size, cursor: movable ? (grab ? "grabbing" : "grab") : "default" }}
      onPointerDown={(e) => { if (!movable) return; e.preventDefault(); drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }; setGrab(true); }}
      role="img" aria-label="Square crop — drag to reposition"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.src} alt="" draggable={false} style={{ position: "absolute", left: ox, top: oy, width: dw, height: dh, userSelect: "none", pointerEvents: "none" }} />
      {movable && <span className="sq-hint">drag to reposition</span>}
    </div>
  );
}

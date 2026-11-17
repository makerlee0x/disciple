"use client";
/**
 * Grok animation clips (handoff doc, maker 2026-11-17). Files live in public/anim/<id>[-9x16|-16x9].mp4 (+ .webp poster
 * for loops). H.264, no audio, so every browser and the iPhone app can play them.
 *
 *  - Loops play muted and inline. With reduced motion they show the poster still.
 *  - One-shots play once and call onEnd (also on error, a stalled load, or reduced motion), so the UI never waits on a video.
 *  - Overlays come back on pure black: `screen` blend makes the black disappear (no alpha channel needed).
 *  - `ratio` picks the portrait or the wide cut from the screen's shape, once, when the clip mounts.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { withBase } from "@/lib/base-path";

export type ClipRatio = "auto" | "none";

/** public/anim/<id>-9x16.mp4 on a portrait screen, -16x9 on a wide one; "none" = one square cut (<id>.mp4). */
export function clipSrc(id: string, ratio: ClipRatio = "auto", ext = "mp4"): string {
  if (ratio === "none") return withBase(`/anim/${id}.${ext}`);
  const tall = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
  return withBase(`/anim/${id}-${tall ? "9x16" : "16x9"}.${ext}`);
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type Props = {
  id: string;
  ratio?: ClipRatio;
  /** loop forever (backgrounds) or play once (moments) */
  loop?: boolean;
  /** loops: show public/anim/<id>[-ratio]-poster.webp until the video plays, and instead of it with reduced motion */
  poster?: boolean;
  /** overlay on black: blend with `screen` so only the light shows */
  overlay?: boolean;
  /** hold without unmounting: a loop pauses, a one-shot waits (preloaded) and starts when this turns false */
  paused?: boolean;
  /** one-shots: called once when the clip ends, fails, stalls past maxMs, or is skipped */
  onEnd?: () => void;
  /** one-shots: give up after this long (default 5 s) */
  maxMs?: number;
  /** start this many seconds in */
  startAt?: number;
  /** loops below the fold: load and play only while on screen */
  whenVisible?: boolean;
  className?: string;
  style?: CSSProperties;
};

export default function AnimClip({ id, ratio = "auto", loop = false, poster = false, overlay = false, paused = false, onEnd, maxMs = 5000, startAt = 0, whenVisible = false, className, style }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const end = useRef(onEnd); end.current = onEnd;
  // picked after mount: the server can't know the screen's shape (and must render the same markup as the first client pass)
  const [pick, setPick] = useState<{ src: string; still?: string; calm: boolean } | null>(null);
  useEffect(() => {
    setPick({ src: clipSrc(id, ratio), still: poster ? clipSrc(id, ratio, "webp").replace(/\.webp$/, "-poster.webp") : undefined, calm: reducedMotion() });
  }, [id, ratio, poster]);
  const src = pick?.src, still = pick?.still, calm = !!pick?.calm;
  const [seen, setSeen] = useState(!whenVisible);

  const finish = () => { if (done.current) return; done.current = true; end.current?.(); };

  useEffect(() => {
    if (loop || !pick || paused) return;
    if (calm) { finish(); return; }
    const t = setTimeout(finish, maxMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop, pick, calm, maxMs, paused]);

  useEffect(() => {
    const v = ref.current;
    if (!whenVisible || !v || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: "200px" });
    io.observe(v);
    return () => io.disconnect();
  }, [whenVisible, pick]);

  useEffect(() => {
    const v = ref.current;
    if (!v || (calm && loop)) return;
    if (paused || !seen) { v.pause(); return; }
    if (startAt && v.currentTime < startAt) { try { v.currentTime = startAt; } catch { /* not seekable yet */ } }
    v.play().catch(() => { if (!loop) finish(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, seen, calm, loop, startAt, src]);

  const base: CSSProperties = { display: "block", objectFit: "cover", pointerEvents: "none", ...(overlay ? { mixBlendMode: "screen" } : null), ...style, ...(!loop && paused ? { visibility: "hidden" } : null) };

  if (!pick) return null;
  if (calm && loop) {
    // eslint-disable-next-line @next/next/no-img-element
    return still ? <img className={className} style={base} src={still} alt="" aria-hidden decoding="async" /> : null;
  }
  if (calm) return null;
  return (
    <video ref={ref} className={className} style={base} src={src} poster={still} muted playsInline autoPlay={!paused && !whenVisible} loop={loop}
      preload={whenVisible && !seen ? "none" : "auto"} aria-hidden disablePictureInPicture onEnded={loop ? undefined : finish} onError={loop ? undefined : finish} />
  );
}

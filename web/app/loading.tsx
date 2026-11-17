/**
 * Route loading screen (Grok clip A1, maker 2026-11-17): the blue-hour pad loop with the moon mark on top.
 * It fades in after 300 ms, so quick page changes never flash it; slow loads (first open in the iPhone app) get the loop.
 */
import AnimClip from "@/components/ui/AnimClip";
import s from "./loading.module.css";

export default function Loading() {
  return (
    <div className={s.boot} role="status" aria-label="Loading" data-testid="boot-loading">
      <AnimClip id="A1-loading" loop poster className={s.clip} />
      <div className={s.scrim} aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={s.mark} src="/brand/disciple-mark-light.svg" alt="" width={56} height={56} />
      <span className={s.bar} aria-hidden><i /></span>
    </div>
  );
}

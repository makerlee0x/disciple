"use client";

import { useEffect, useRef, useState } from "react";
import { composeRocket, loadBaseRocket, type DecalOpts } from "@/lib/decal";

/**
 * /create live preview: large rotatable branded rocket on the pad, light/dark backdrop,
 * plus a "see it in flight" mini preview. Re-composites only when icon/opts change.
 */
export default function RocketStudio({ icon, opts }: { icon: CanvasImageSource | null; opts: DecalOpts }) {
  const big = useRef<HTMLCanvasElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const sprite = useRef<HTMLCanvasElement | null>(null);
  const fadeT = useRef(0);
  const [rot, setRot] = useState(0);
  const [idle, setIdle] = useState(true);
  const [light, setLight] = useState(false);
  const rotRef = useRef(rot); rotRef.current = rot;
  const idleRef = useRef(idle); idleRef.current = idle;
  const lightRef = useRef(light); lightRef.current = light;

  useEffect(() => {
    let alive = true;
    loadBaseRocket().then((b) => {
      if (!alive) return;
      sprite.current = composeRocket(b, icon, 4, opts);
      fadeT.current = performance.now();
    });
    return () => { alive = false; };
  }, [icon, opts]);

  useEffect(() => {
    let raf = 0;
    const clouds = [...Array(7)].map(() => ({ x: Math.random(), y: Math.random(), s: 0.3 + Math.random() * 0.6 }));
    const draw = (now: number) => {
      const t = now / 1000, sp = sprite.current;
      const a = big.current?.getContext("2d"), m = mini.current?.getContext("2d");
      if (a && big.current) {
        const W = big.current.width, H = big.current.height;
        const g = a.createLinearGradient(0, 0, 0, H);
        if (lightRef.current) { g.addColorStop(0, "#dfe9ff"); g.addColorStop(1, "#ffffff"); }
        else { g.addColorStop(0, "#0b0f22"); g.addColorStop(1, "#1a1630"); }
        a.fillStyle = g; a.fillRect(0, 0, W, H);
        a.fillStyle = lightRef.current ? "rgba(40,40,70,.18)" : "rgba(255,231,163,.18)";
        a.beginPath(); a.ellipse(W / 2, H * 0.9, W * 0.3, H * 0.035, 0, 0, 7); a.fill();
        if (sp) {
          const h = H * 0.78, w = (h * sp.width) / sp.height;
          const wob = idleRef.current ? Math.sin(t * 1.6) * 4 : 0, bob = idleRef.current ? Math.sin(t * 2.3) * 4 : 0;
          a.save(); a.translate(W / 2, H * 0.89 + bob); a.rotate(((rotRef.current + wob) * Math.PI) / 180);
          a.globalAlpha = Math.min(1, (now - fadeT.current) / 300);
          a.drawImage(sp, -w / 2, -h, w, h); a.restore();
        }
      }
      if (m && mini.current) {
        const W = mini.current.width, H = mini.current.height;
        const g = m.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#3a4f8f"); g.addColorStop(1, "#b9c8ee");
        m.fillStyle = g; m.fillRect(0, 0, W, H);
        for (const c of clouds) {
          const y = ((c.y + t * 0.25 * c.s) % 1.2) * H - 0.1 * H;
          m.fillStyle = "rgba(255,255,255,.55)"; m.beginPath(); m.ellipse(c.x * W, y, 40 * c.s, 14 * c.s, 0, 0, 7); m.fill();
        }
        if (sp) {
          const h = H * 0.55, w = (h * sp.width) / sp.height;
          m.save(); m.translate(W / 2 + Math.sin(t) * 14, H * 0.8); m.rotate(0.35 + Math.sin(t * 0.8) * 0.08);
          const fl = m.createRadialGradient(0, 0, 0, 0, 0, 26 + Math.random() * 6);
          fl.addColorStop(0, "rgba(255,245,220,.95)"); fl.addColorStop(1, "rgba(255,170,90,0)");
          m.fillStyle = fl; m.fillRect(-30, -10, 60, 50);
          m.drawImage(sp, -w / 2, -h, w, h); m.restore();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const btn = "rounded-lg border border-[rgba(255,231,163,.4)] px-2 py-1 text-[11px] text-[#ffe7a3]";
  return (
    <div className="space-y-2">
      <div className="flex gap-3">
        <canvas ref={big} width={320} height={420} aria-label="branded rocket preview" className="rounded-xl border border-[rgba(255,231,163,.3)]" style={{ width: 320, height: 420 }} />
        <div className="flex flex-col gap-2">
          <span className="text-[11px] tracking-wider text-[#ffe7a3]">SEE IT IN FLIGHT</span>
          <canvas ref={mini} width={180} height={240} aria-label="flight preview" className="rounded-xl border border-[rgba(255,231,163,.3)]" style={{ width: 180, height: 240 }} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#ffe7a3]">
        <label className="flex items-center gap-1">ROTATE
          <input type="range" min={-35} max={35} value={rot} onChange={(e) => setRot(+e.target.value)} aria-label="rotate preview" />
        </label>
        <button type="button" className={btn} onClick={() => setIdle((v) => !v)}>{idle ? "Idle anim ON" : "Idle anim OFF"}</button>
        <button type="button" className={btn} onClick={() => setLight((v) => !v)}>{light ? "☀ Light bg" : "☾ Dark bg"}</button>
      </div>
    </div>
  );
}

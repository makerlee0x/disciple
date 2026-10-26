"use client";
/**
 * Debug page: /dev/replay — renders a deterministic share-video replay (public/flight/replay.js) from a synthetic
 * trade list and records it to WebM with MediaRecorder. Not linked from the UI. ?seed=N&sec=12&fps=30
 */
import { useEffect, useRef, useState } from "react";
import { demoTrades } from "@/lib/flight/replayDemo";

type Handle = { canvas: HTMLCanvasElement; frames: number; step(): { i: number; t: number; done: boolean } | null; hash(): string; dispose(): void;
  on(k: string, cb: (d: unknown) => void): () => void };
type ReplayFn = (o: Record<string, unknown>) => Promise<Handle>;
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

function loadReplay(): Promise<ReplayFn> {
  const w = window as unknown as { __flightReplay?: ReplayFn; __DISCIPLE_BASE_PATH__?: string };
  w.__DISCIPLE_BASE_PATH__ = BASE;
  if (w.__flightReplay) return Promise.resolve(w.__flightReplay);
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = BASE + "/flight/replay.js"; s.onload = () => res(w.__flightReplay!); s.onerror = rej; document.head.appendChild(s); });
}

export default function DevReplay() {
  const box = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const say = (s: string) => setLog((l) => [...l.slice(-12), s]);
  const opts = () => { const q = new URLSearchParams(location.search), d = demoTrades(+(q.get("seed") || 7));
    return { coin: "0xdemo", supply: 1e6, ticker: "DEMO", ...d, durationSec: +(q.get("sec") || 12), fps: +(q.get("fps") || 30), width: 1080, height: 1920, seed: +(q.get("seed") || 7), clean: q.get("clean") !== "0" }; };
  useEffect(() => { (window as unknown as Record<string, unknown>).__replayDemo = { demoTrades, opts, loadReplay }; }, []);
  async function record() {
    setBusy(true); setUrl("");
    try {
      const r = await (await loadReplay())(opts());
      r.on("tier", (d) => say("tier " + JSON.stringify(d))); r.on("bomb", (d) => say("bomb " + JSON.stringify(d)));
      const c = r.canvas; c.style.width = "270px"; c.style.height = "480px"; box.current?.replaceChildren(c);
      const stream = c.captureStream(0), track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined), parts: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      const done = new Promise<void>((res) => (rec.onstop = () => res()));
      rec.start(); const fd = 1000 / 30; const t0 = performance.now();
      for (let i = 0; ; i++) { const f = r.step(); if (!f) break; track.requestFrame?.(); const wait = t0 + (i + 1) * fd - performance.now(); await new Promise((x) => setTimeout(x, Math.max(0, wait))); }
      rec.stop(); await done; setUrl(URL.createObjectURL(new Blob(parts, { type: "video/webm" }))); say(`recorded ${r.frames} frames · last hash ${r.hash()}`);
    } catch (e) { say("error " + String(e)); }
    setBusy(false);
  }
  return (
    <div style={{ padding: 20, color: "#e8ecff", background: "#0b0a12", minHeight: "100vh", fontFamily: "ui-monospace,monospace" }}>
      <h2>Replay → WebM (debug)</h2>
      <button data-testid="replay-record" disabled={busy} onClick={record}>{busy ? "rendering…" : "Render + record WebM"}</button>
      {url && <> {" "}<a data-testid="replay-download" href={url} download="disciple-replay.webm" style={{ color: "#9ff3c8" }}>download .webm</a></>}
      <div ref={box} style={{ marginTop: 12 }} />
      <pre style={{ fontSize: 11 }}>{log.join("\n")}</pre>
    </div>
  );
}

/**
 * Share VIDEO: ~12 s deterministic replay (GAME's window.__flight.replay, PR #50) + ~3 s end card (lib/share/scene.ts),
 * 1080×1920 @30fps. Encoder ladder: WebCodecs H.264 + mp4-muxer → MediaRecorder (mp4 if supported, else webm) → null
 * (caller falls back to the PNG). The replay engine is loaded headlessly from /flight/replay.js (it sandboxes its own
 * engine.js instance), so the profile page never mounts the game.
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { drawShareScene, composeRocket, tierAt, FONT, type SceneData, type MakeCanvas, type Loadout } from "./scene";
import type { Fill } from "../trades";
import type { LoadoutIds } from "./loadout";
import type { PositionPnl } from "../sharePnl";

export type ReplayTrade = { ts: number; tx: string; li: number; side: "buy" | "sell"; usd: number; mcapUsd: number; impactBps: number; trader: string; mine: boolean };
type ReplayHandle = { loadout?: { skin: string; thruster: string; noseCoin: string; accessory?: string | null; stats?: Record<string, number> }; canvas: HTMLCanvasElement; frames: number; fps: number; step(): { i: number; t: number; done: boolean } | null; hash(): string; dispose(): void; on(k: string, cb: (d: unknown) => void): () => void };
type ReplayFn = (o: Record<string, unknown>) => Promise<ReplayHandle>;

export const VIDEO = { width: 1080, height: 1920, fps: 30, replaySec: 12, endSec: 3 };
const BASE = () => process.env.NEXT_PUBLIC_BASE_PATH || "";

/** Feature-detect the replay hook: live game's __flight.replay, an already-loaded __flightReplay, or load replay.js. */
export async function getReplay(timeoutMs = 8000): Promise<ReplayFn | null> {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __flight?: { replay?: ReplayFn }; __flightReplay?: ReplayFn; __DISCIPLE_BASE_PATH__?: string };
  if (typeof w.__flight?.replay === "function") return w.__flight.replay.bind(w.__flight);
  if (typeof w.__flightReplay === "function") return w.__flightReplay;
  w.__DISCIPLE_BASE_PATH__ ??= BASE();
  const ok = await new Promise<boolean>((res) => {
    const s = document.createElement("script"); s.src = BASE() + "/flight/replay.js"; s.async = true;
    const t = setTimeout(() => res(false), timeoutMs);
    s.onload = () => { clearTimeout(t); res(true); }; s.onerror = () => { clearTimeout(t); res(false); };
    document.head.appendChild(s);
  });
  return ok && typeof w.__flightReplay === "function" ? w.__flightReplay : null;
}

/** Pure: indexed coin fills → replay trades. Mine = wallet's fills; window [first buy, now | final sell]. */
export function buildReplayTrades(coinFills: Fill[], wallet: string, pnl: Pick<PositionPnl, "startTs" | "endTs" | "kind">) {
  const me = wallet.toLowerCase();
  const sorted = [...coinFills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const t0 = pnl.startTs, t1 = Math.max(pnl.endTs, t0 + 1);
  const before = sorted.filter((f) => f.ts < t0);
  const startMcap = before.length ? before[before.length - 1].mcapUsd : sorted[0]?.mcapUsd ?? 7777;
  let prev = startMcap;
  const trades: ReplayTrade[] = sorted.filter((f) => f.ts >= t0 && f.ts <= t1).map((f) => {
    const impactBps = prev > 0 ? Math.round(Math.abs(f.mcapUsd / prev - 1) * 10_000) : 0; prev = f.mcapUsd;
    return { ts: f.ts, tx: f.tx, li: f.logIndex, side: f.side, usd: f.usd, mcapUsd: f.mcapUsd, impactBps, trader: f.trader, mine: f.trader === me };
  });
  return { trades, t0, t1, startMcap };
}

/* ---------------- end card assets (browser) ---------------- */
const mkDom: MakeCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c as never; };
const img = (src: string) => new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
let fontsP: Promise<void> | null = null;
export function loadShareFonts() {
  return (fontsP ??= (async () => {
    const list: [string, string][] = [[FONT.black, "Geist-Black.ttf"], [FONT.mono, "GeistMono-Bold.ttf"], [FONT.monoMed, "GeistMono-Medium.ttf"]];
    await Promise.all(list.map(async ([fam, f]) => { const ff = new FontFace(fam, `url(${BASE()}/fonts/share/${f})`); await ff.load(); document.fonts.add(ff); }));
  })().catch(() => {}));
}
export async function endCardAssets(mcapEnd: number, lo: Loadout) {
  await loadShareFonts();
  const [bg, base, wordmark] = await Promise.all([img(`${BASE()}${tierAt(mcapEnd).sky}`), img(`${BASE()}/assets/rocket.png`), img(`${BASE()}/brand/disciple-wordmark-light-1200.png`)]);
  return { bg, rocket: base ? composeRocket(mkDom, base, lo, 4) : null, wordmark };
}

/* ---------------- encoders ---------------- */
export type VideoResult = { blob: Blob; mime: string; ext: "mp4" | "webm"; via: "webcodecs" | "mediarecorder"; frames: number; replayHash?: string };
type FrameSource = { total: number; draw(i: number, ctx: CanvasRenderingContext2D): void };

async function pickAvc(w: number, h: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === "undefined") return null;
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.640033"]) {
    const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate: 10_000_000, framerate: VIDEO.fps, avc: { format: "avc" } } as VideoEncoderConfig;
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  return null;
}

async function encodeWebCodecs(src: FrameSource, cv: HTMLCanvasElement, onP: (p: number) => void): Promise<VideoResult | null> {
  const cfg = await pickAvc(cv.width, cv.height); if (!cfg) return null;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: cv.width, height: cv.height, frameRate: VIDEO.fps }, fastStart: "in-memory" });
  let err: unknown = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { err = e; } });
  enc.configure(cfg);
  const ctx = cv.getContext("2d")!;
  for (let i = 0; i < src.total; i++) {
    src.draw(i, ctx);
    const vf = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / VIDEO.fps), duration: Math.round(1e6 / VIDEO.fps) });
    enc.encode(vf, { keyFrame: i % (VIDEO.fps * 2) === 0 }); vf.close();
    if (enc.encodeQueueSize > 8) await new Promise<void>((r) => enc.addEventListener("dequeue", () => r(), { once: true }));
    if (err) throw err;
    if (i % 5 === 0) { onP(i / src.total); await new Promise((r) => setTimeout(r, 0)); }
  }
  await enc.flush(); enc.close(); muxer.finalize();
  onP(1);
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), mime: "video/mp4", ext: "mp4", via: "webcodecs", frames: src.total };
}

async function encodeMediaRecorder(src: FrameSource, cv: HTMLCanvasElement, onP: (p: number) => void): Promise<VideoResult | null> {
  if (typeof MediaRecorder === "undefined" || !cv.captureStream) return null;
  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  const stream = cv.captureStream(0), track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 }), parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  const ctx = cv.getContext("2d")!;
  rec.start();
  const t0 = performance.now(), fd = 1000 / VIDEO.fps; // real-time pacing (MediaRecorder timestamps are wall clock)
  for (let i = 0; i < src.total; i++) {
    src.draw(i, ctx); track.requestFrame?.(); onP(i / src.total);
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + (i + 1) * fd - performance.now())));
  }
  rec.stop(); await stopped; onP(1);
  const isMp4 = mime.startsWith("video/mp4");
  return { blob: new Blob(parts, { type: isMp4 ? "video/mp4" : "video/webm" }), mime: isMp4 ? "video/mp4" : "video/webm", ext: isMp4 ? "mp4" : "webm", via: "mediarecorder", frames: src.total };
}

/** Render replay + end card and encode. Returns null when no replay hook or no encoder (→ PNG fallback). */
export async function renderShareVideo(opts: {
  coin: string; ticker: string; wallet: string; pnl: PositionPnl; coinFills: Fill[]; scene: SceneData; loadout: Loadout;
  /** Rocket Factory ids (rocketSkin ids without prefixes) → replay({loadout:{skin, thruster, noseCoin}}) so the replayed rocket matches the end card */
  loadoutIds: LoadoutIds;
  onProgress?: (p: number, stage: string) => void; forceEncoder?: "webcodecs" | "mediarecorder";
}): Promise<VideoResult | null> {
  const onP = opts.onProgress ?? (() => {});
  onP(0, "loading replay engine");
  const replay = await getReplay(); if (!replay) return null;
  const { trades, t0, t1, startMcap } = buildReplayTrades(opts.coinFills.length ? opts.coinFills : opts.pnl.fills, opts.wallet, opts.pnl);
  const replayLoadout = { skin: opts.loadoutIds.skin, thruster: opts.loadoutIds.thruster, noseCoin: opts.loadoutIds.coin,
    ...(opts.loadoutIds.accessory ? { accessory: opts.loadoutIds.accessory } : {}), ...(opts.loadoutIds.stats ? { stats: opts.loadoutIds.stats } : {}) };   // accessory/stats: cosmetic only
  const seed = Number.parseInt(opts.coin.slice(2, 10) || "7", 16) ^ Number.parseInt(opts.wallet.slice(2, 10) || "1", 16);
  const r = await replay({ coin: opts.coin, supply: 1e6, ticker: opts.ticker, t0, t1, trades, startMcap, durationSec: VIDEO.replaySec, fps: VIDEO.fps,
    width: VIDEO.width, height: VIDEO.height, seed, clean: true, loadout: replayLoadout });
  if (r.loadout && (r.loadout.skin !== replayLoadout.skin || r.loadout.noseCoin !== replayLoadout.noseCoin)) console.warn("[share] replay normalized loadout", r.loadout);
  onP(0, "preparing end card");
  const assets = await endCardAssets(opts.scene.mcapEnd, opts.loadout);
  const endFrames = VIDEO.endSec * VIDEO.fps, total = r.frames + endFrames;
  let lastReplayHash = "";
  const src: FrameSource = {
    total,
    draw(i, ctx) {
      if (i < r.frames) { r.step(); ctx.drawImage(r.canvas, 0, 0, VIDEO.width, VIDEO.height); if (i === r.frames - 1) lastReplayHash = r.hash(); return; }
      const k = i - r.frames, t = Math.min(1, k / (VIDEO.fps * 1.2));
      drawShareScene(ctx, mkDom, opts.scene, assets, opts.loadout, { format: "story", t, seed: 7 + (k % 4) });
      if (k < 8) { ctx.fillStyle = `rgba(255,250,235,${(1 - k / 8) * 0.6})`; ctx.fillRect(0, 0, VIDEO.width, VIDEO.height); } // flash cut
    },
  };
  const cv = document.createElement("canvas"); cv.width = VIDEO.width; cv.height = VIDEO.height;
  const prog = (p: number) => onP(p, "encoding");
  try {
    let out: VideoResult | null = null;
    if (opts.forceEncoder !== "mediarecorder") out = await encodeWebCodecs(src, cv, prog).catch((e) => { console.warn("[share] webcodecs failed", e); return null; });
    if (!out && opts.forceEncoder !== "webcodecs") {
      // replay frames were consumed if WebCodecs failed midway → restart the replay for the recorder
      const r2 = await replay({ coin: opts.coin, supply: 1e6, ticker: opts.ticker, t0, t1, trades, startMcap, durationSec: VIDEO.replaySec, fps: VIDEO.fps, width: VIDEO.width, height: VIDEO.height, seed, clean: true, loadout: replayLoadout });
      Object.assign(r, { step: r2.step.bind(r2), canvas: r2.canvas, hash: r2.hash.bind(r2) });
      out = await encodeMediaRecorder(src, cv, prog);
    }
    if (out) out.replayHash = lastReplayHash;
    return out;
  } finally { r.dispose(); }
}

/**
 * Duel share CLIP (maker 2026-11-18): the whole duel at 2x, 720x1280 vertical, + a ~3 s end card → ~33 s MP4.
 *
 * The duel engine (public/turbo/duel/engine.js) composes each frame into its own 720x1280 canvas while the match runs
 * and hands it to add(). Frames are encoded as they come (WebCodecs H.264, hardware where the device has it) with their
 * real time halved, so 60 s of play becomes 30 s of video at ~60 fps and nothing piles up in memory.
 *
 * Trading is never touched: a tap sends its order over the network, outside this path. The recorder only ever drops its
 * own frames — when the encoder is behind, add() skips the frame instead of waiting — and the engine stops recording
 * for the match if composing gets too slow (see engine.js clipFrame). No WebCodecs → createDuelClip returns null and the
 * result SHARE stays the PNG card.
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export const CLIP = { width: 720, height: 1280, speed: 2, captureFps: 30, endSec: 3, bitrate: 4_000_000 };

export type DuelClip = {
  /** a composed frame at real time `realMs` (performance.now()); skipped when the encoder is behind or it's too soon */
  add(cv: HTMLCanvasElement | OffscreenCanvas, realMs: number): boolean;
  /** stop capturing, append the end card (drawn by `paint(alpha)` into `cv` for each frame), return the MP4 */
  finish(cv: HTMLCanvasElement, paint: (t: number) => void, endSec?: number): Promise<Blob | null>;
  abort(): void;
  stats(): { frames: number; skipped: number; queueMax: number; outSec: number };
};

async function pickConfig(w: number, h: number, fps: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  // level 3.2+ for 720p at 60 fps: Main, Baseline, High
  for (const codec of ["avc1.4d0020", "avc1.42e020", "avc1.640020", "avc1.4d0028", "avc1.640028"]) {
    // no-preference: the browser uses the hardware encoder where there is one ("prefer-hardware" can pass
    // isConfigSupported and then close the codec on devices without one)
    const cfg = { codec, width: w, height: h, bitrate: CLIP.bitrate, framerate: fps, avc: { format: "avc" } } as VideoEncoderConfig;
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  return null;
}

// some encoders hand back decoderConfig without a colorSpace (or none on later keyframes); mp4-muxer reads it
const BT709 = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false } as VideoColorSpaceInit;
function fixMeta(meta?: EncodedVideoChunkMetadata): EncodedVideoChunkMetadata | undefined {
  if (!meta || !meta.decoderConfig) return meta?.decoderConfig === null ? { ...meta, decoderConfig: undefined } : meta;
  return meta.decoderConfig.colorSpace ? meta : { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: BT709 } };
}

export async function createDuelClip(o: Partial<typeof CLIP> = {}): Promise<DuelClip | null> {
  const c = { ...CLIP, ...o };
  const outFps = c.captureFps * c.speed;
  const cfg = await pickConfig(c.width, c.height, outFps).catch(() => null);
  if (!cfg) return null;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: c.width, height: c.height, frameRate: outFps }, fastStart: "in-memory" });
  let err: unknown = null, dead = false, t0 = -1, lastSlot = -1, lastTs = 0, frames = 0, skipped = 0, queueMax = 0, sinceKey = 1e9;
  const enc = new VideoEncoder({ output: (chunk, meta) => { if (!dead) muxer.addVideoChunk(chunk, fixMeta(meta)); }, error: (e) => { err = e; } });
  try { enc.configure(cfg); } catch { return null; }
  const slotMs = 1000 / c.captureFps, frameUs = 1e6 / outFps;   // 33.3 ms of play per 16.7 ms of video
  const keyEvery = 2e6;                          // a keyframe every 2 s of output (µs)

  const push = (cv: HTMLCanvasElement | OffscreenCanvas, tsUs: number) => {
    const vf = new VideoFrame(cv as HTMLCanvasElement, { timestamp: Math.round(tsUs), duration: Math.round(frameUs) });   // mp4-muxer needs a duration on every chunk
    const key = tsUs - sinceKey >= keyEvery || frames === 0; if (key) sinceKey = tsUs;
    enc.encode(vf, { keyFrame: key }); vf.close(); frames++; lastTs = tsUs;
  };

  const abort = () => { if (dead) return; dead = true; try { enc.close(); } catch { /* closed */ } };
  return {
    add(cv, realMs) {
      if (dead || err) return false;
      // a fixed frame grid (maker 2026-11-18: the first clips juddered): every capture lands on output slot n, n * 1/60 s,
      // with slot = round(real elapsed / 33.3 ms). rAF jitter can't make uneven gaps, and a missed slot just holds a frame.
      if (t0 < 0) t0 = realMs;
      const slot = Math.round((realMs - t0) / slotMs);
      if (slot <= lastSlot) return false;
      queueMax = Math.max(queueMax, enc.encodeQueueSize);
      if (enc.encodeQueueSize > 6) { skipped++; return false; }   // encoder behind: drop our frame, never wait
      lastSlot = slot;
      try { push(cv, slot * frameUs); return true; } catch (e) { err = e; return false; }
    },
    async finish(cv, paint, endSec = c.endSec) {
      if (dead || err || frames === 0) { console.warn("[duelClip] nothing to finish", { dead, err, frames }); abort(); return null; }
      try {
        const n = Math.round(endSec * outFps);
        for (let i = 0; i < n; i++) {
          paint(i / 30);
          push(cv, lastTs + frameUs);
          if (enc.encodeQueueSize > 8) await new Promise<void>((r) => enc.addEventListener("dequeue", () => r(), { once: true }));
        }
        await enc.flush(); enc.close(); muxer.finalize(); dead = true;
        if (err) { console.warn("[duelClip] encoder", err); return null; }
        return new Blob([muxer.target.buffer], { type: "video/mp4" });
      } catch (e) { console.warn("[duelClip] finish", e); abort(); return null; }
    },
    abort,
    stats: () => ({ frames, skipped, queueMax, outSec: lastTs / 1e6 }),
  };
}

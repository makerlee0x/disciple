"use client";
/**
 * Browser pre-check (instant feedback only — the server /api/moderate-image is authoritative).
 * nsfwjs + tfjs are lazy-loaded the first time an image is picked; model is bundled (no CDN).
 */
import { decideNsfw, type ModerationVerdict } from "./config";
import { withBase } from "./base-path";

type Model = { classify(img: HTMLImageElement): Promise<{ className: string; probability: number }[]> };
let modelP: Promise<Model> | null = null;

async function model(): Promise<Model> {
  modelP ||= (async () => {
    await import("@tensorflow/tfjs");
    // Static model files exported by scripts/export-nsfw-model.cjs (webpack can't parse nsfwjs's shard bundles).
    const { load } = await import("nsfwjs/core");
    return (await load(withBase("/models/nsfw/mobilenet_v2/model.json"), { size: 224 })) as unknown as Model;
  })();
  return modelP;
}

/**
 * Synthetic scores for tests/screenshots: ?modmock=porn|sexy|review (dev only).
 * Never uses real explicit images.
 */
function mockScores(): Record<string, number> | null {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_MODERATION_ALLOW_MOCK !== "1") return null;
  const m = new URLSearchParams(location.search).get("modmock");
  if (m === "porn") return { Porn: 0.91, Hentai: 0.02, Sexy: 0.05, Neutral: 0.02 };
  if (m === "sexy") return { Porn: 0.05, Hentai: 0.01, Sexy: 0.9, Neutral: 0.04 };
  if (m === "review") return { Porn: 0.4, Hentai: 0.02, Sexy: 0.3, Neutral: 0.28 };
  return null;
}

export async function precheck(img: HTMLImageElement): Promise<{ verdict: ModerationVerdict; scores: Record<string, number> }> {
  const mock = mockScores();
  if (mock) return { verdict: decideNsfw(mock), scores: mock };
  const preds = await (await model()).classify(img);
  const scores = Object.fromEntries(preds.map((p) => [p.className, p.probability]));
  return { verdict: decideNsfw(scores), scores };
}

/** Start loading the model in the background (call on page mount) so the first check is instant. */
export function preloadModeration() {
  if (typeof window === "undefined") return;
  model().catch(() => { modelP = null; });
}

/** precheck with a hard timeout. Resolves "timeout" instead of hanging. */
export async function precheckWithin(img: HTMLImageElement, ms = 3000) {
  return Promise.race([
    precheck(img),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ]);
}

/** Small on-chain-safe icon URI: 128px WEBP data URL (~3–8 KB). */
export function iconDataUri(img: HTMLImageElement, size = 128): string {
  const c = document.createElement("canvas");
  const s = Math.min(1, size / Math.max(img.naturalWidth || size, img.naturalHeight || size));
  c.width = Math.max(1, Math.round((img.naturalWidth || size) * s));
  c.height = Math.max(1, Math.round((img.naturalHeight || size) * s));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  const webp = c.toDataURL("image/webp", 0.8);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/png");
}

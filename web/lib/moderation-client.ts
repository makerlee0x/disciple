"use client";
/**
 * Browser pre-check (instant feedback only — the server /api/moderate-image is authoritative).
 * nsfwjs + tfjs are lazy-loaded the first time an image is picked; model is bundled (no CDN).
 */
import { decideNsfw, type ModerationVerdict } from "./config";

type Model = { classify(img: HTMLImageElement): Promise<{ className: string; probability: number }[]> };
let modelP: Promise<Model> | null = null;

async function model(): Promise<Model> {
  modelP ||= (async () => {
    await import("@tensorflow/tfjs");
    // Static model files exported by scripts/export-nsfw-model.cjs (webpack can't parse nsfwjs's shard bundles).
    const { load } = await import("nsfwjs/core");
    return (await load("/models/nsfw/mobilenet_v2/model.json", { size: 224 })) as unknown as Model;
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

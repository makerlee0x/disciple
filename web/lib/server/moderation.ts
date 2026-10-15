import "server-only";
import { createHash, createHmac } from "crypto";
import { decideNsfw, MODERATION, type ModerationVerdict } from "@/lib/config";
import { rgb224 } from "./image";

export interface ModerationResult {
  verdict: ModerationVerdict;
  provider: string;
  scores?: Record<string, number>;
  labels?: string[];
}

/** Provider adapter. Each reads its own env keys; unconfigured providers are skipped. */
export interface ModerationProvider {
  name: string;
  configured(): boolean;
  check(img: Buffer, mime: string): Promise<ModerationResult>;
}

/* ---------- AWS Rekognition DetectModerationLabels (SigV4, no SDK) ---------- */
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const rekognition: ModerationProvider = {
  name: "aws-rekognition",
  configured: () => !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION),
  async check(img) {
    const region = process.env.AWS_REGION!, host = `rekognition.${region}.amazonaws.com`;
    const body = JSON.stringify({ Image: { Bytes: img.toString("base64") }, MinConfidence: 40 });
    const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amz.slice(0, 8);
    const target = "RekognitionService.DetectModerationLabels";
    const tok = process.env.AWS_SESSION_TOKEN;
    const hdrs: Record<string, string> = { "content-type": "application/x-amz-json-1.1", host, "x-amz-date": amz, "x-amz-target": target };
    if (tok) hdrs["x-amz-security-token"] = tok;
    const names = Object.keys(hdrs).sort();
    const canon = ["POST", "/", "", names.map((n) => `${n}:${hdrs[n]}\n`).join(""), names.join(";"), sha(body)].join("\n");
    const scope = `${day}/${region}/rekognition/aws4_request`;
    const sts = ["AWS4-HMAC-SHA256", amz, scope, sha(canon)].join("\n");
    let k = hmac("AWS4" + process.env.AWS_SECRET_ACCESS_KEY, day);
    for (const p of [region, "rekognition", "aws4_request"]) k = hmac(k, p);
    const sig = createHmac("sha256", k).update(sts).digest("hex");
    hdrs.authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
    const r = await fetch(`https://${host}/`, { method: "POST", headers: hdrs, body });
    if (!r.ok) throw new Error("rekognition " + r.status);
    const j = (await r.json()) as { ModerationLabels?: { Name: string; ParentName?: string; Confidence: number }[] };
    const L = j.ModerationLabels || [];
    const top = (re: RegExp) => Math.max(0, ...L.filter((l) => re.test(l.Name) || re.test(l.ParentName || "")).map((l) => l.Confidence / 100));
    const scores = { Porn: top(/Explicit|Sexual Activity|Explicit Nudity/i), Hentai: top(/Illustrated Explicit|Animated/i), Sexy: top(/Suggestive|Non-Explicit Nudity/i) };
    return { verdict: decideNsfw(scores), provider: this.name, scores, labels: L.map((l) => l.Name) };
  },
};

/* ---------- Google Cloud Vision SafeSearch ---------- */
const LIKELY: Record<string, number> = { UNKNOWN: 0, VERY_UNLIKELY: 0.05, UNLIKELY: 0.2, POSSIBLE: 0.5, LIKELY: 0.75, VERY_LIKELY: 0.95 };
export const googleVision: ModerationProvider = {
  name: "google-vision",
  configured: () => !!process.env.GOOGLE_VISION_API_KEY,
  async check(img) {
    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: img.toString("base64") }, features: [{ type: "SAFE_SEARCH_DETECTION" }] }] }),
    });
    if (!r.ok) throw new Error("vision " + r.status);
    const a = (await r.json()).responses?.[0]?.safeSearchAnnotation || {};
    const scores = { Porn: LIKELY[a.adult] ?? 0, Hentai: 0, Sexy: LIKELY[a.racy] ?? 0 };
    return { verdict: decideNsfw(scores), provider: this.name, scores };
  },
};

/* ---------- Sightengine (nudity-2.1) ---------- */
export const sightengine: ModerationProvider = {
  name: "sightengine",
  configured: () => !!(process.env.SIGHTENGINE_API_USER && process.env.SIGHTENGINE_API_SECRET),
  async check(img, mime) {
    const fd = new FormData();
    fd.append("media", new Blob([new Uint8Array(img)], { type: mime }), "image");
    fd.append("models", "nudity-2.1");
    fd.append("api_user", process.env.SIGHTENGINE_API_USER!);
    fd.append("api_secret", process.env.SIGHTENGINE_API_SECRET!);
    const r = await fetch("https://api.sightengine.com/1.0/check.json", { method: "POST", body: fd });
    if (!r.ok) throw new Error("sightengine " + r.status);
    const n = (await r.json()).nudity || {};
    const scores = {
      Porn: Math.max(n.sexual_activity ?? 0, n.sexual_display ?? 0),
      Hentai: n.erotica ?? 0,
      Sexy: Math.max(n.very_suggestive ?? 0, n.suggestive ?? 0),
    };
    return { verdict: decideNsfw(scores), provider: this.name, scores };
  },
};

/* ---------- Fallback: server-side nsfwjs on pure-JS tfjs (no tfjs-node native build) ---------- */
type NsfwModel = { classify(x: unknown): Promise<{ className: string; probability: number }[]> };
let modelP: Promise<{ tf: typeof import("@tensorflow/tfjs"); m: NsfwModel }> | null = null;
export const nsfwjsServer: ModerationProvider = {
  name: "nsfwjs-server",
  configured: () => true,
  async check(img) {
    modelP ||= (async () => {
      const tf = await import("@tensorflow/tfjs");
      const [{ load }, { MobileNetV2Model }] = await Promise.all([import("nsfwjs/core"), import("nsfwjs/models/mobilenet_v2")]);
      return { tf, m: (await load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] })) as unknown as NsfwModel };
    })();
    const { tf, m } = await modelP;
    const x = tf.tensor3d(new Uint8Array(await rgb224(img)), [224, 224, 3], "int32");
    try {
      const preds = await m.classify(x);
      const scores = Object.fromEntries(preds.map((p) => [p.className, p.probability]));
      return { verdict: decideNsfw(scores), provider: this.name, scores };
    } finally {
      x.dispose();
    }
  },
};

/**
 * Test-only mock: MODERATION_MOCK_SCORES='{"Porn":0.9}' returns synthetic scores.
 * Refused in production builds unless MODERATION_ALLOW_MOCK=1.
 */
export const mockProvider: ModerationProvider = {
  name: "mock",
  configured: () => !!process.env.MODERATION_MOCK_SCORES && (process.env.NODE_ENV !== "production" || process.env.MODERATION_ALLOW_MOCK === "1"),
  async check() {
    const scores = JSON.parse(process.env.MODERATION_MOCK_SCORES || "{}");
    return { verdict: decideNsfw(scores), provider: this.name, scores };
  },
};

const ALL: Record<string, ModerationProvider> = {
  mock: mockProvider, rekognition, google: googleVision, sightengine, nsfwjs: nsfwjsServer,
};

/** MODERATION_PROVIDER=rekognition|google|sightengine|nsfwjs|mock; default = first configured, else nsfwjs. */
export function pickProvider(): ModerationProvider {
  const want = process.env.MODERATION_PROVIDER;
  if (want && ALL[want]?.configured()) return ALL[want];
  for (const p of [mockProvider, rekognition, googleVision, sightengine]) if (p.configured()) return p;
  return nsfwjsServer;
}

export { MODERATION };

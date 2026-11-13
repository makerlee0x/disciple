import "server-only";
/** Server PNG for the share scene (lib/share/scene.ts) via @napi-rs/canvas. */
import path from "path";
import { createCanvas, GlobalFonts, loadImage, type Image } from "@napi-rs/canvas";
import { drawShareScene, composeRocket, scenePeak, tierAt, FONT, type SceneData, type MakeCanvas } from "@/lib/share/scene";
import { loadoutFromIds, type LoadoutIds } from "@/lib/share/loadout";

const ROOT = process.cwd();
let fontsOk = false;
function fonts() {
  if (fontsOk) return; fontsOk = true;
  const f = (n: string) => path.join(ROOT, "public/fonts/share", n);
  GlobalFonts.registerFromPath(f("Geist-Black.ttf"), FONT.black);
  GlobalFonts.registerFromPath(f("GeistMono-Bold.ttf"), FONT.mono);
  GlobalFonts.registerFromPath(f("GeistMono-Medium.ttf"), FONT.monoMed);
  GlobalFonts.registerFromPath(f("BarlowCondensed-SemiBold.ttf"), FONT.game600);
  GlobalFonts.registerFromPath(f("BarlowCondensed-Bold.ttf"), FONT.game700);
  GlobalFonts.registerFromPath(f("BarlowCondensed-ExtraBold.ttf"), FONT.game800);
  GlobalFonts.registerFromPath(f("Inter-SemiBold.ttf"), FONT.ui600);
}
const imgs = new Map<string, Promise<Image | null>>();
const load = (n: string, ext: string) => loadImage(path.join(ROOT, "public/assets", n + ext));
/** tier skies: the .webp plates the game draws (the old .png copies are darker), else the .png */
const asset = (n: string, ext = ".png") => { const k = n + ext; let p = imgs.get(k); if (!p) { p = load(n, ext).catch(() => (ext === ".png" ? null : load(n, ".png").catch(() => null))); imgs.set(k, p); } return p; };
let wordmarkP: Promise<Image | null> | null = null;
const wordmark = () => (wordmarkP ??= loadImage(path.join(ROOT, "public/brand/disciple-wordmark-light-1200.png")).catch(() => null));
const mk: MakeCanvas = (w, h) => createCanvas(w, h) as never;

export async function renderSharePng(d: SceneData, ids: Partial<LoadoutIds>, format: "story" | "og", coinIcon?: Buffer | null): Promise<Buffer> {
  fonts();
  const lo = loadoutFromIds(ids);
  const [bg, base, wm, ic] = await Promise.all([asset(tierAt(scenePeak(d)).bg, ".webp"), asset("rocket"), wordmark(), coinIcon ? loadImage(coinIcon).catch(() => null) : null]);
  const rocket = base ? composeRocket(mk, base, lo, 4) : null;
  const H = format === "story" ? 1920 : 1080;
  const c = createCanvas(1080, H);
  drawShareScene(c.getContext("2d"), mk, d, { bg, rocket, wordmark: wm, coinIcon: ic, wing: base }, lo, { format });
  return c.encode("png");
}

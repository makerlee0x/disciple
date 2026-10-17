import "server-only";
/** Server PNG for the share scene (lib/share/scene.ts) via @napi-rs/canvas. */
import path from "path";
import { createCanvas, GlobalFonts, loadImage, type Image } from "@napi-rs/canvas";
import { drawShareScene, composeRocket, tierAt, FONT, type SceneData, type MakeCanvas } from "@/lib/share/scene";
import { loadoutFromIds, type LoadoutIds } from "@/lib/share/loadout";

const ROOT = process.cwd();
let fontsOk = false;
function fonts() {
  if (fontsOk) return; fontsOk = true;
  const f = (n: string) => path.join(ROOT, "public/fonts/share", n);
  GlobalFonts.registerFromPath(f("Geist-Black.ttf"), FONT.black);
  GlobalFonts.registerFromPath(f("GeistMono-Bold.ttf"), FONT.mono);
  GlobalFonts.registerFromPath(f("GeistMono-Medium.ttf"), FONT.monoMed);
}
const imgs = new Map<string, Promise<Image | null>>();
const asset = (n: string) => { let p = imgs.get(n); if (!p) { p = loadImage(path.join(ROOT, "public/assets", n + ".png")).catch(() => null); imgs.set(n, p); } return p; };
let wordmarkP: Promise<Image | null> | null = null;
const wordmark = () => (wordmarkP ??= loadImage(path.join(ROOT, "public/brand/disciple-wordmark-light-1200.png")).catch(() => null));
const mk: MakeCanvas = (w, h) => createCanvas(w, h) as never;

export async function renderSharePng(d: SceneData, ids: Partial<LoadoutIds>, format: "story" | "og"): Promise<Buffer> {
  fonts();
  const lo = loadoutFromIds(ids);
  const [bg, base, wm] = await Promise.all([asset(tierAt(d.mcapEnd).bg), asset("rocket"), wordmark()]);
  const rocket = base ? composeRocket(mk, base, lo, 4) : null;
  const H = format === "story" ? 1920 : 1080;
  const c = createCanvas(1080, H);
  drawShareScene(c.getContext("2d"), mk, d, { bg, rocket, wordmark: wm }, lo, { format });
  return c.encode("png");
}

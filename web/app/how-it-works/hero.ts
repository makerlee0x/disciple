/**
 * /how-it-works hero assets (BRAND perf-hiw release, copied to public/how-it-works/) and the hero's critical CSS.
 * The hero CSS is inlined in the HTML (a <style> in page.tsx) so the first screen's layout, blur-up sky and headline
 * size do not depend on the route stylesheet; shared pieces (eyebrow, CTA buttons) stay in page.module.css.
 * No entrance fade anywhere in the hero: the sky, rocket and headline paint in their final state. Line heights are pinned
 * (eyebrow: Geist Mono's own `normal`, 1.24; subhead: the inherited 1.5) and the subhead width to 765px (= 60ch of Geist at 19px; `ch` changes with
 * the font) so the swap from the system fallback can't move the hero copy (CLS 0).
 */
import { withBase } from "@/lib/base-path";

const P = (f: string) => withBase(`/how-it-works/${f}`);
const set = (name: string, ext: string, ws: number[]) => ws.map((w) => `${P(`${name}-${w}.${ext}`)} ${w}w`).join(", ");

/** Phones get the portrait crop (moon upper right), wider screens the 16:9 plate. Keep in sync with the 760px breakpoint. */
export const MQ_MOBILE = "(max-width: 760px)";
export const MQ_DESKTOP = "(min-width: 761px)";
export const SIZES_MOBILE = "100vw";
export const SIZES_DESKTOP = "calc(100vw - 270px)"; // the sidebar is 270px wide on desktop

export const SKY = {
  mobileAvif: set("hero-sky-mobile", "avif", [414, 828]),
  mobileWebp: set("hero-sky-mobile", "webp", [414, 828]),
  desktopAvif: set("hero-sky-desktop", "avif", [1280, 1920]),
  desktopWebp: set("hero-sky-desktop", "webp", [1280, 1920]),
  fallback: P("hero-sky-desktop-1280.webp"),
};

/** Rocket plates: 108×300 and 163×450 (height in the name). */
export const ROCKET = {
  avif: set("hero-rocket", "avif", [300, 450]).replace(" 300w", " 108w").replace(" 450w", " 163w"),
  webp: set("hero-rocket", "webp", [300, 450]).replace(" 300w", " 108w").replace(" 450w", " 163w"),
  fallback: P("hero-rocket-300.webp"),
};

/** Tiny blurred previews painted as the hero background until the real plate decodes (inlined, no request). */
const LQIP_MOBILE = "data:image/webp;base64,UklGRnAAAABXRUJQVlA4IGQAAADwAwCdASoQABgAPu1iqk2ppaQiMAgBMB2JQAALVAIIBXpbQitVHY4AAP7uk8eUN9jaelzonkYLUdSssR3t74CeUf4Qa8iomb9lq2dzwalytOdrEtLSGxfeg1rTEZogGsMCAAAA";
const LQIP_DESKTOP = "data:image/webp;base64,UklGRnIAAABXRUJQVlA4IGYAAADwAwCdASoYAA0APu1kqk2ppaQiMAgBMB2JZQDE2CHrTqHTAEybY3AAAP7uf4H59jljzak8FN/E0zoW4Xdyx/WlRRQLvPCcXgFu2JbxJz+uvWoMpzmSlZSmqMri/PchhflZBRYwAAA=";

export const HERO_CSS = `
.hiw-hero{position:relative;height:600px;overflow:hidden}
.hiw-sky{position:absolute;inset:0;background:var(--dsc-sky-indigo,#202141) url("${LQIP_DESKTOP}") 50% 35%/cover no-repeat}
.hiw-skyimg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 35%}
.hiw-shade{position:absolute;inset:0;background:linear-gradient(0deg,rgba(11,12,14,1) 0%,rgba(11,12,14,.82) 26%,rgba(11,12,14,.35) 52%,rgba(11,12,14,0) 70%),var(--dsc-gradient-scrim-top)}
.hiw-rocket{left:50%;top:86px}
.hiw-copy{position:absolute;left:0;right:0;top:318px;text-align:center;padding:0 24px}
.hiw-h1{margin:18px 0 0;font:400 66px/1 var(--dsc-font-display);letter-spacing:-.01em}
.hiw-eyebrow{line-height:1.24}
.hiw-sub{max-width:765px;margin:16px auto 0;font-size:19px;line-height:1.5;color:var(--dsc-muted-on-sky);text-wrap:balance}
@media (prefers-reduced-motion:no-preference){.hiw-rocket{animation:hiw-bob 6s ease-in-out infinite alternate}}
@keyframes hiw-bob{from{transform:translateX(-50%) translateY(0)}to{transform:translateX(-50%) translateY(-6px)}}
@media ${MQ_MOBILE}{
.hiw-hero{height:646px}
.hiw-sky{background-image:url("${LQIP_MOBILE}");background-position:50% 50%}
.hiw-skyimg{object-position:50% 50%}
.hiw-copy{top:292px;padding:0 20px}
.hiw-h1{font-size:37px;line-height:1.04}
.hiw-hl{display:block;white-space:nowrap}
.hiw-sub{font-size:16px}
}`.replace(/\n/g, "");

"""
Pair-art asset generator (offline; outputs are committed). Port of disciple-shots/h2h-mocks v6 make6.py
+ v7/v8 tweaks (coin at 90%, silver chrome rim, group centered, haze behind/below only, light grain).

  python3 scripts/pair-art/gen.py [SRC_DIR]

Writes (under web/public):
  pairs/<tk>.png        512px square base-pair logo (full-bleed; shown inside a circle)
  pairs/coin/<tk>.webp  256px silver-chrome-rimmed coin, transparent, drop shadow baked in
  pairs/sm/<tk>.webp    64px coin with a simplified flat-silver rim (tiny icons)
  pair-art/sky.webp     dreamcore cloud sky w/ haze below + group shadow + grain (card background)
  pair-art/grain.png    transparent grain tile laid over the pair at low opacity
  pair-art/sq/*.webp    gritty monogram placeholder squares for SAMPLE coins (+ saylor)
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageEnhance, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(os.path.dirname(HERE))
PUB = os.path.join(WEB, "public")
SRC = sys.argv[1] if len(sys.argv) > 1 else "/workspace/pairart/src"
rng = np.random.default_rng(11)
SS = 4

def mk(*p):
    d = os.path.join(PUB, *p); os.makedirs(d, exist_ok=True); return d

def fit(im, sz): return ImageOps.fit(im, (sz, sz), Image.LANCZOS)
def mask(w, h, fn):
    m = Image.new("L", (w * SS, h * SS), 0); fn(ImageDraw.Draw(m), SS); return m.resize((w, h), Image.LANCZOS)
def circ(sz): return mask(sz, sz, lambda d, k: d.ellipse((0, 0, sz * k - 1, sz * k - 1), 255))

# ---------- 1. logos ----------
def on_disc(mark, bg, scale=0.62, dy=0.0, tint=None):
    o = Image.new("RGBA", (512, 512), bg + (255,))
    m = Image.open(mark).convert("RGBA"); bb = m.getbbox(); m = m.crop(bb)
    if tint: m = Image.merge("RGBA", [Image.new("L", m.size, c) for c in tint] + [m.split()[3]])
    m.thumbnail((int(512 * scale), int(512 * scale)), Image.LANCZOS)
    o.alpha_composite(m, ((512 - m.width) // 2, int((512 - m.height) / 2 + dy * 512)))
    return o

def full(path, bg=(255, 255, 255), inset=1.0):
    m = Image.open(path).convert("RGBA")
    o = Image.new("RGBA", m.size, bg + (255,)); o.alpha_composite(m)
    w, h = o.size; s = min(w, h); o = o.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    if inset < 1:
        b = Image.new("RGBA", (s, s), bg + (255,)); t = o.resize((int(s * inset),) * 2, Image.LANCZOS)
        b.alpha_composite(t, ((s - t.width) // 2,) * 2); o = b
    return o.resize((512, 512), Image.LANCZOS)

S_ = lambda f: os.path.join(SRC, f)

def nvda_eye():
    """Maker-provided NVIDIA tile, cropped to the eye mark (wordmark is illegible at coin size)."""
    im = Image.open(S_("nvda.jpg")).convert("RGB"); w = im.width / 225
    eye = im.crop((int(46 * w), int(40 * w), int(164 * w), int(117 * w)))
    bg = im.getpixel((int(8 * w), int(112 * w)))
    o = Image.new("RGB", (512, 512), bg); e = eye.resize((330, int(330 * eye.height / eye.width)), Image.LANCZOS)
    o.paste(e, ((512 - e.width) // 2, (512 - e.height) // 2)); return o
LOGOS = {
    "eth": lambda: full(S_("eth.png"), (206, 208, 214)),
    "usdg": lambda: full(S_("usdg.png"), (52, 70, 24)),
    "strategy": lambda: full(S_("strategy.png"), (226, 32, 48)),
    "ai": lambda: full(S_("ai.png")), "boner": lambda: full(S_("boner.png")), "pons": lambda: full(S_("pons.png")),
    "moo": lambda: full(S_("moo.png")), "orbio": lambda: full(S_("orbio.png"), (0, 0, 0)), "zzz": lambda: full(S_("zzz.png"), (0, 0, 0)),
    "delta": lambda: full(S_("delta.png")), "shroom": lambda: full(S_("shroom.png")), "bow": lambda: full(S_("bow.png")),
    "googl": lambda: full(S_("googl.png"), (255, 255, 255), 0.66),
    "tsla": lambda: full(S_("tsla.png"), (226, 30, 40)),
    "nvda": lambda: nvda_eye(),
    "spcx": lambda: on_disc(S_("spcx_mark.png"), (12, 12, 16), 0.7, 0.03, (245, 245, 250)),
    "mstr": lambda: on_disc(S_("mstr_mark.png"), (255, 255, 255), 0.5),
}

# ---------- 2. silver chrome rim coin (make6.rimcoin, 'silver' env) ----------
PAL = ((255, 255, 255), (185, 190, 200), (48, 50, 56), (10, 10, 12))
def env(ny):
    sky0, sky1, hz, gnd = [np.array(c, float) for c in PAL]
    a = np.clip((ny + 1) / 1.05, 0, 1)[..., None]; up = sky0 * (1 - a) + sky1 * a
    b = np.clip((ny - 0.05) / 0.95, 0, 1)[..., None]; dn = hz * (1 - b) + gnd * b
    k = 1 / (1 + np.exp(-(ny - 0.05) * 60))[..., None]
    return up * (1 - k) + dn * k

def rim_ring(d, rw):
    D = d + 2 * rw; K = 3; N = D * K
    yy, xx = (np.mgrid[0:N, 0:N] + 0.5) / K - D / 2; r = np.hypot(xx, yy); th = np.arctan2(yy, xx)
    t = np.clip((D / 2 - r) / rw, 0, 1); s = np.cos(t * np.pi)
    ridge = (t < 0.3) * np.sin(th * D * 1.1) * 0.45            # reeded edge
    sx, sy = np.cos(th), np.sin(th); nx = s * sx - ridge * sy; ny = s * sy + ridge * sx
    col = env(ny) * (0.75 + 0.35 * np.clip(-(nx * 0.6 + ny * 0.8), -1, 1))[..., None]
    dot = nx * -0.62 + ny * -0.78; spec = np.clip((dot - 0.9) / 0.06, 0, 1) ** 2   # hard specular
    streak = np.exp(-((th + 2.25) / 0.10) ** 2) * np.exp(-((t - 0.35) / 0.12) ** 2) + np.exp(-((th - 0.85) / 0.06) ** 2) * np.exp(-((t - 0.62) / 0.08) ** 2) * 0.8
    col = col + (255 - col) * np.clip(spec + streak, 0, 1)[..., None]
    for e, w, a in ((0.0, 0.035, 0.85), (1.0, 0.06, 0.95), (0.5, 0.02, 0.25)):
        col *= (1 - a * np.exp(-((t - e) / w) ** 2))[..., None]
    return Image.fromarray(np.clip(col, 0, 255).astype("uint8")).resize((D, D), Image.LANCZOS)

RING = None
def rimcoin(logo, d=420, rw=38):
    global RING
    if RING is None: RING = rim_ring(d, rw)
    D = d + 2 * rw
    o = Image.new("RGBA", (D, D), (0, 0, 0, 0)); o.paste(RING, (0, 0), circ(D)); o.paste(fit(logo.convert("RGB"), d), (rw, rw), circ(d))
    io = Image.new("L", (D, D), 0); ImageDraw.Draw(io).ellipse((rw, rw, rw + d, rw + d), outline=255, width=10)
    o.paste((0, 0, 0), (0, 0), Image.composite(io.filter(ImageFilter.GaussianBlur(5)), Image.new("L", (D, D), 0), circ(D)).point(lambda v: v * 0.45))
    return o

PADC = 0.16  # shadow padding on each side, fraction of the coin diameter (CSS mirrors this)
def with_shadow(coin, out):
    D = coin.width; p = int(D * PADC); W = D + 2 * p
    o = Image.new("RGBA", (W, W), (0, 0, 0, 0)); m = Image.new("L", (W, W), 0)
    m.paste(coin.split()[3].point(lambda v: v * 200 // 255), (p + int(D * .05), p + int(D * .06)))
    o.paste((14, 6, 26, 255), (0, 0), m.filter(ImageFilter.GaussianBlur(D * .055)))
    o.alpha_composite(coin, (p, p))
    return o.resize((out, out), Image.LANCZOS)

def small(logo, n=64):
    K = 4; N = n * K; o = Image.new("RGBA", (N, N), (0, 0, 0, 0)); rw = int(N * 0.09)
    g = np.linspace(0, 1, N)[:, None].repeat(N, 1)
    ring = np.stack([235 - 120 * g, 238 - 118 * g, 244 - 112 * g], -1)   # flat silver, light top -> dark bottom
    o.paste(Image.fromarray(ring.astype("uint8")), (0, 0), circ(N))
    ImageDraw.Draw(o).ellipse((1, 1, N - 2, N - 2), outline=(40, 42, 48, 255), width=K * 1)
    o.paste(fit(logo.convert("RGB"), N - 2 * rw), (rw, rw), circ(N - 2 * rw))
    return o.resize((n, n), Image.LANCZOS)

# ---------- 3. background ----------
GEOM = dict(sq=0.742, coin=0.468, coinAt=0.532, frac=0.86)  # mirrored in components/pairart/PairArt.tsx
def sky_bg(S=640):
    im = Image.open(os.path.join(PUB, "assets", "tier3.png")).convert("RGB"); w, h = im.size
    im = im.crop((w // 2 - h // 2 + 60, 0, w // 2 + h // 2 - 60, h - 120)).resize((S, S), Image.LANCZOS)
    b = ImageEnhance.Color(im).enhance(1.2)
    r = S * 0.36; m = mask(S, S, lambda d, k: d.ellipse(((S/2 - r) * k, (S/2 - r) * k, (S/2 + r) * k, (S/2 + r) * k), 170)).filter(ImageFilter.GaussianBlur(r * .45))
    b.paste((255, 236, 210), (0, 0), m)
    rr = np.random.default_rng(6)
    n = sum(np.asarray(Image.fromarray((rr.random((s, s)) * 255).astype("uint8")).resize((S, S), Image.BICUBIC)).astype(float) / (2 ** i) for i, s in enumerate((4, 8, 16, 32)))
    n = (n - n.min()) / (n.max() - n.min()); yy = np.linspace(0, 1, S)[:, None]; grad = np.clip((yy - 0.8 + 0.35) / 0.5, 0, 1)
    b.paste((225, 215, 250), (0, 0), Image.fromarray(np.clip(n * grad * 120 * 1.6, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(3)))
    # group silhouette shadow (behind the pair, offset down-right)
    g = GEOM; off = (1 - g["frac"]) / 2 * S; u = g["frac"] * S
    sh = Image.new("L", (S, S), 0); dd = ImageDraw.Draw(sh); o2 = S * 0.012
    dd.rounded_rectangle((off + o2, off + o2, off + o2 + g["sq"] * u, off + o2 + g["sq"] * u), int(g["sq"] * u * 0.1125), 140)
    c0 = off + g["coinAt"] * u + o2; dd.ellipse((c0, c0, c0 + g["coin"] * u, c0 + g["coin"] * u), 140)
    b.paste((40, 20, 70), (0, 0), sh.filter(ImageFilter.GaussianBlur(S * 0.04)))
    a = np.asarray(b).astype(np.float32); a += rng.normal(0, 18, (S, S, 1))
    yy, xx = np.mgrid[0:S, 0:S]; c = S / 2; a *= (1 - 0.4 * (((xx - c) ** 2 + (yy - c) ** 2) / (2 * c * c)))[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype("uint8"))

def grain(n=192):
    v = rng.normal(0, 1, (n, n)); a = np.clip(np.abs(v) * 70, 0, 255).astype("uint8")
    lum = np.where(v > 0, 255, 0).astype("uint8")
    return Image.merge("RGBA", [Image.fromarray(lum)] * 3 + [Image.fromarray(a)])

# ---------- 4. placeholder squares (gritty monogram) ----------
FONT = "/usr/share/fonts/truetype/sand-box/google/Barlow Condensed/BarlowCondensed-Bold.ttf"
SQ_COLORS = [((232, 92, 60), (40, 18, 12)), ((246, 206, 72), (40, 30, 8)), ((96, 170, 120), (10, 30, 18)), ((90, 120, 220), (10, 14, 40)),
             ((200, 96, 190), (36, 10, 34)), ((236, 236, 226), (24, 24, 22)), ((120, 210, 230), (8, 30, 36)), ((40, 40, 46), (230, 226, 210)),
             ((180, 60, 70), (250, 230, 210)), ((150, 120, 240), (20, 12, 46)), ((250, 150, 80), (48, 20, 6)), ((70, 90, 70), (230, 240, 200))]
def mono_square(txt, ci, n=256, seed=0):
    bg, fg = SQ_COLORS[ci % len(SQ_COLORS)]; r = np.random.default_rng(seed)
    yy = np.linspace(0, 1, n)[:, None]; a = np.ones((n, n, 3)) * np.array(bg, float) * (1.08 - 0.22 * yy)[..., None]
    im = Image.fromarray(np.clip(a, 0, 255).astype("uint8")); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, int(n * (0.62 if len(txt) <= 2 else 0.44)))
    bb = d.textbbox((0, 0), txt, font=f); w, h = bb[2] - bb[0], bb[3] - bb[1]
    x, y = (n - w) / 2 - bb[0], (n - h) / 2 - bb[1]
    d.text((x + n * .02, y + n * .025), txt, font=f, fill=tuple(int(c * .55) for c in bg))
    d.text((x, y), txt, font=f, fill=fg)
    a = np.asarray(im).astype(np.float32); a += r.normal(0, 16, (n, n, 1))
    speck = r.random((n, n)) > 0.985; a[speck] = a[speck] * 0.5
    return Image.fromarray(np.clip(a, 0, 255).astype("uint8"))

if __name__ == "__main__":
    lp, cp, sp = mk("pairs"), mk("pairs", "coin"), mk("pairs", "sm")
    for tk, fn in LOGOS.items():
        logo = fn(); logo.convert("RGB").save(os.path.join(lp, f"{tk}.png"), optimize=True)
        with_shadow(rimcoin(logo), 256).save(os.path.join(cp, f"{tk}.webp"), quality=88, method=6)
        small(logo).save(os.path.join(sp, f"{tk}.webp"), quality=90, method=6)
        print("pair", tk)
    ap = mk("pair-art"); sky_bg().save(os.path.join(ap, "sky.webp"), quality=80, method=6); grain().save(os.path.join(ap, "grain.png"), optimize=True)
    qp = mk("pair-art", "sq")
    words = ["HA", "LI", "SE", "PE", "CH", "PS", "MA", "EX", "ZI", "GO", "EM", "VE", "RE", "AB", "OR", "NI", "CU", "LA", "CO", "GL", "SA", "HY", "AR", "LU"]
    for i, wd in enumerate(words): mono_square(wd, i, seed=i).save(os.path.join(qp, f"m{i:02d}.webp"), quality=82, method=6)
    sq = Image.open(S_("saylor.jpg")).convert("RGB"); fit(ImageEnhance.Contrast(sq).enhance(1.12), 320).save(os.path.join(qp, "saylor.webp"), quality=86, method=6)
    print(json.dumps(GEOM))

"""
Step-2 world environments for the flight ship (run: python3 build_world_env.py; needs numpy + Pillow).

Input: BRAND's env plates r1 (disciple-brand/mockups/flight-3d-lookdev-r1/env/<tier>.boost.hdr, 2560x1280, linear, plate
centre at +X / u=0.5, spanning 180 deg). Those wrap the approved sky plate; behind it (the back half) each row is only a
blend of the plate's own edge colours, so a mirror hull, which mostly reflects what is BEHIND the camera, sees a flat
gradient and reads as satin paint.

This script keeps the plate half exactly as BRAND made it, keeps BRAND's wrap colours behind it, and adds the tier's
ground in 3D: each back-half pixel below the plate's horizon is ray-cast onto a ground / cloud-floor plane under the ship
(what three.js's PMREMGenerator.fromScene would capture of a real ground, done once offline so the game loads one .hdr):
  - launch-pad:   the plate's sodium city continues behind the camera: point lights on the ground plane (colour = median
                  of the plate's city-light pixels, #cc976d, with some of its #F2D7A0), clustered in towns, perspective-
                  correct (they bunch up toward the horizon), over the plate's own lit ground fog (its colour from the
                  plate's fog rows), which dims the near city.
  - the-moon:     the plate's cloud floor continues all around under the ship: BRAND's wrap colour there, with cloud
                  texture laid on the floor plane in perspective.
  - ozone:        same for the plate's cloud deck.
  - the-moon / outer-space: the plate's star field continues across the back half of the sky.
  - seventh-heaven: no ground in the picture; unchanged (resampled only).
Nothing is added above the horizon or inside the plate, no studio lights, no strips. Output 2048x1024 RGBE (.hdr) for
three's HDRLoader -> PMREM (512 px cube, the same as from the 2560 source).
"""
import numpy as np, os, sys
from PIL import Image

SRC = os.environ.get("ENV_SRC", "/workspace/disciple-brand/mockups/flight-3d-lookdev-r1/env")
OUT = os.environ.get("ENV_OUT", os.path.join(os.path.dirname(__file__), "../../../../public/world/env"))
OW = 2048

def read_hdr(p):
    b = open(p, 'rb').read(); i = b.index(b'\n\n') + 2; j = b.index(b'\n', i); d = b[i:j].decode().split(); H = int(d[1]); W = int(d[3]); pos = j + 1
    out = np.zeros((H, W, 4), np.uint8)
    for y in range(H):
        if b[pos] == 2 and b[pos + 1] == 2:
            pos += 4
            for c in range(4):
                x = 0
                while x < W:
                    n = b[pos]; pos += 1
                    if n > 128: n -= 128; out[y, x:x + n, c] = b[pos]; pos += 1
                    else: out[y, x:x + n, c] = np.frombuffer(b[pos:pos + n], np.uint8); pos += n
                    x += n
        else:
            out[y] = np.frombuffer(b[pos:pos + W * 4], np.uint8).reshape(W, 4); pos += W * 4
    e = out[..., 3].astype(np.int32); f = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0)
    return out[..., :3].astype(np.float64) * f[..., None]

def write_hdr(p, img):
    H, W, _ = img.shape; m = img.max(-1); man, ex = np.frexp(m); sc = np.where(m > 1e-32, man * 256.0 / np.maximum(m, 1e-32), 0)
    rgbe = np.zeros((H, W, 4), np.uint8); rgbe[..., :3] = np.clip(img * sc[..., None], 0, 255).astype(np.uint8); rgbe[..., 3] = np.where(m > 1e-32, ex + 128, 0)
    with open(p, 'wb') as f:
        f.write(b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + f'-Y {H} +X {W}\n'.encode())
        for y in range(H):
            f.write(bytes([2, 2, W >> 8, W & 255]))
            for c in range(4):
                row = rgbe[y, :, c]; x = 0; buf = bytearray()
                while x < W:
                    r = 1
                    while x + r < W and r < 127 and row[x + r] == row[x]: r += 1
                    if r >= 4: buf += bytes([128 + r, row[x]]); x += r
                    else:
                        s = x
                        while x < W and x - s < 128:
                            if x + 3 < W and row[x] == row[x + 1] == row[x + 2] == row[x + 3]: break
                            x += 1
                        buf += bytes([x - s]) + row[s:x].tobytes()
                f.write(buf)

def resample(img, W):
    return np.stack([np.asarray(Image.fromarray(img[..., c].astype(np.float32), 'F').resize((W, W // 2), Image.BOX)) for c in range(3)], -1).astype(np.float64)

def srgb2lin(c): c = np.asarray(c, float) / 255; return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))

def fbm(x, y, oct=5, seed=3):
    rng = np.random.default_rng(seed); tot = 0; amp = 1; norm = 0
    for o in range(oct):
        g = rng.standard_normal((64, 64)); f = 2 ** o
        xi = (x * f) % 64; yi = (y * f) % 64; x0 = np.floor(xi).astype(int); y0 = np.floor(yi).astype(int); tx = xi - x0; ty = yi - y0
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty)
        a = g[y0 % 64, x0 % 64]; b = g[y0 % 64, (x0 + 1) % 64]; c = g[(y0 + 1) % 64, x0 % 64]; d = g[(y0 + 1) % 64, (x0 + 1) % 64]
        tot += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty); norm += amp; amp *= 0.5
    return tot / norm

def geometry(H, W):
    v = (np.arange(H) + 0.5) / H; u = (np.arange(W) + 0.5) / W
    el = (0.5 - v) * np.pi                       # row 0 = up (image top = +Y, matches lights.json elevations)
    az = (u - 0.5) * 2 * np.pi                    # 0 = +X = plate centre
    EL, AZ = np.meshgrid(el, az, indexing='ij')
    back = sm(np.radians(75), np.radians(110), np.abs(AZ))   # 0 inside the plate's 180 deg, 1 behind it
    return EL, AZ, back

def ground(EL, AZ, h=1.0):
    t = np.where(EL < -1e-4, h / np.tan(np.maximum(-EL, 1e-4)), np.inf)
    return t * np.cos(AZ), t * np.sin(AZ), t

def city(img, el0=0.0, fog_el=None):
    """Launch Pad: the plate's sodium city continues on the ground behind the camera. Lights are points on a ground plane
    (clustered in towns by an fbm density), projected into the wrap, so they bunch up toward the horizon like the plate's."""
    H, W, _ = img.shape; EL, AZ, back = geometry(H, W)
    rng = np.random.default_rng(11); N = 220000; R = 160.0
    rr = R * np.sqrt(rng.random(N)) + 1.5; th = rng.random(N) * 2 * np.pi
    px, pz = rr * np.cos(th), rr * np.sin(th)
    dens = fbm(px / 8 + 7, pz / 8 + 3, 4, 5); keep = rng.random(N) < np.clip((dens - 0.0) * 1.8, 0, 1) * 0.6
    px, pz, rr = px[keep], pz[keep], rr[keep]
    sod = srgb2lin([204, 151, 109]); warm = srgb2lin([242, 215, 160])
    acc = np.zeros((H, W, 3))
    el = np.radians(el0) - np.arctan2(1.0, rr); azp = np.arctan2(pz, px)
    ys = (0.5 - el / np.pi) * H; xs = (azp / (2 * np.pi) + 0.5) * W
    inten = (0.6 + 3.0 * rng.random(len(rr)) ** 4) * 2.2 * np.exp(-rr / 55)
    tint = rng.random(len(rr))[:, None]; col = sod[None, :] * (1 - 0.35 * tint) + warm[None, :] * 0.35 * tint
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            w = np.exp(-(dx * dx + dy * dy) / 0.5)
            yi = np.clip(np.floor(ys).astype(int) + dy, 0, H - 1); xi = (np.floor(xs).astype(int) + dx) % W
            np.add.at(acc, (yi, xi), col * (inten * w)[:, None])
    gm = sm(np.radians(el0 + 0.5), np.radians(el0 - 1.0), EL) * back
    if fog_el is not None:   # the near city is under the plate's lit ground fog: dimmed there, the far city stays clear
        acc *= (1 - 0.7 * sm(np.radians(fog_el + 0.5), np.radians(fog_el - 2.0), EL))[..., None]
        return img + acc * gm[..., None]
    return img * (1 - 0.25 * gm[..., None]) + acc * gm[..., None]

def floor_world(img, el_plate, el_back=-6.0, scale=5.0, contrast=0.5, seed=4, rows=(610, 710), gain=1.0):
    """the plate's cloud floor continues all around under the ship: BRAND's wrap colour there, with cloud texture laid on
    the floor plane in perspective (so it compresses toward the horizon). The plate's own horizon sits low (the plate looks
    up at its sky); behind the camera the floor's horizon rises to el_back (a flat floor seen from just above it), easing
    from the plate's value at the plate edges."""
    H, W, _ = img.shape; EL, AZ, back = geometry(H, W)
    el0 = np.radians(el_plate + (el_back - el_plate) * back)
    e = EL - el0
    t = np.where(e < -1e-4, 1.0 / np.tan(np.maximum(-e, 1e-4)), 0)
    gx, gz = t * np.cos(AZ), t * np.sin(AZ)
    n = fbm(gx / scale + 11, gz / scale + 5, 5, seed); n2 = fbm(gx / (scale * 0.3) + 2, gz / (scale * 0.3) + 9, 3, seed + 1)
    fog = np.exp(-t / 30.0)
    # floor colour: the plate's own floor (median of its bottom rows, central 60%), so behind the camera it is as bright
    # as the floor you see in the plate; the wrap's edge-blend there is darker only because of the plate's lens vignette
    floorc = gain * np.median(img[280 + rows[0]:280 + rows[1], 640 + 256:1920 - 256].reshape(-1, 3), 0)
    horiz = np.stack([img[np.clip(((0.5 - el0[0] / np.pi) * H).astype(int) - 4, 0, H - 1), np.arange(W)]], 0)
    tex = floorc[None, None, :] * (1 + contrast * (0.75 * n + 0.25 * n2))[..., None]
    base = tex * fog[..., None] + horiz * (1 - fog[..., None])
    gm = sm(0.5 * np.pi / 180, -2.0 * np.pi / 180, e) * back
    return img * (1 - gm[..., None]) + base * gm[..., None]

def stars(img, el_min=-90.0, n=9000, seed=21, gain=1.0):
    """the plate's star field continues across the back half of the sky (space tiers): small white points, a few bright"""
    H, W, _ = img.shape; EL, AZ, back = geometry(H, W)
    rng = np.random.default_rng(seed)
    z = rng.uniform(np.sin(np.radians(el_min)), 1, n); th = rng.uniform(-np.pi, np.pi, n)
    el = np.arcsin(z); ys = ((0.5 - el / np.pi) * H).astype(int).clip(0, H - 1); xs = ((th / (2 * np.pi) + 0.5) * W).astype(int) % W
    inten = gain * (0.25 + 2.5 * rng.random(n) ** 6)
    acc = np.zeros((H, W)); np.add.at(acc, (ys, xs), inten)
    return img + (acc * back)[..., None] * np.array([0.95, 0.96, 1.0])[None, None, :]

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for tier in sys.argv[1:] or ["launch-pad", "ozone", "outer-space", "the-moon", "seventh-heaven"]:
        img = read_hdr(os.path.join(SRC, f"{tier}.boost.hdr"))
        note = ""
        # horizon elevations read off each plate in the wrap (plate row -> elevation: (0.5 - (280 + row) / 1280) * 180)
        # launch-pad: city lights along the plate's horizon (~0 deg), its sodium-lit ground fog just below (plate rows
        # 390-450, el ~ -4 to -13): behind the camera the fog floor continues, with the far city above it
        if tier == "launch-pad": img = city(floor_world(img, -4.0, -4.0, contrast=0.35, rows=(390, 450), gain=0.7), 0.0, fog_el=-4.0); note = "city + fog floor"
        elif tier == "the-moon": img = stars(floor_world(img, -27.0), el_min=-20); note = "cloud floor + stars"
        elif tier == "ozone": img = floor_world(img, -29.0); note = "cloud deck"
        elif tier == "outer-space": img = stars(img, gain=1.2); note = "stars"
        out = resample(img, OW)
        write_hdr(os.path.join(OUT, f"{tier}.hdr"), out)
        print(tier, out.shape, round(float(out.max()), 2), note)

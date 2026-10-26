#!/usr/bin/env python3
"""Generate Disciple-themed achievement icons (navy medallion, chrome+gold ring, gold glyph).
One SVG per achievement id in lib/achievements.ts → public/achievements/<id>.svg.
Re-run after adding achievements:  python3 scripts/gen-achievement-icons.py
"""
import os, re
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
src = open(os.path.join(ROOT, "lib/achievements.ts")).read()
ach = re.findall(r'A\("([a-z0-9_]+)",\s*"[^"]*",\s*"[^"]*",\s*"([a-z]+)",\s*"([A-Z]+)"', src)

# Rarity scale (lib/config RARITY_SCALE) — shared with rocket parts, not the season-rank names.
RING = {"COMMON": ("#c9d2e6", "#7d879f"), "RARE": ("#bfe3ff", "#5f9fd6"),
        "EPIC": ("#e3d4ff", "#9877d6"), "LEGENDARY": ("#fff1c4", "#d9a640"), "MYTHIC": ("#ffffff", "#ffd060")}

# Glyph primitives (64x64 canvas, centre 32,32). stroke = gold, fill = chrome/gold.
ROCKET = '<path d="M32 12c7 6 9 15 8 25l-4 6h-8l-4-6c-1-10 1-19 8-25z" class="f"/><circle cx="32" cy="27" r="3.4" class="w"/><path d="M24 37l-6 7 7-1M40 37l6 7-7-1" class="s"/><path d="M29 45l3 7 3-7" class="flame"/>'
HALO = '<ellipse cx="32" cy="14" rx="11" ry="3.4" class="s"/>'
WINGS = '<path d="M30 34c-8-9-18-10-24-5 6 1 9 4 10 7-4 0-7 1-8 3 6 0 12 1 22-2z M34 34c8-9 18-10 24-5-6 1-9 4-10 7 4 0 7 1 8 3-6 0-12 1-22-2z" class="f"/>'
GATE = '<path d="M18 50V28a14 14 0 0128 0v22" class="s"/><path d="M24 50V30a8 8 0 0116 0v20M32 22v28" class="s"/>'
CLOUD = '<path d="M16 42a8 8 0 018-8 10 10 0 0119-2 7 7 0 016 10z" class="f"/>'
STAR = '<path d="M32 14l4.5 10 11 1-8.3 7.4 2.5 10.8L32 37.6 22.3 43.2l2.5-10.8L16.5 25l11-1z" class="f"/>'
SPARK = '<path d="M32 12v40M12 32h40M19 19l26 26M45 19L19 45" class="s"/><circle cx="32" cy="32" r="5" class="f"/>'
CHART = '<path d="M14 46l10-12 8 6 16-20" class="s"/><path d="M42 20h6v6" class="s"/>'
CROWN = '<path d="M16 42l-2-18 10 8 8-12 8 12 10-8-2 18z" class="f"/><path d="M16 46h32" class="s"/>'
KEY = '<circle cx="24" cy="26" r="8" class="s"/><path d="M30 32l16 16M40 42l4-4M44 46l4-4" class="s"/>'
PEOPLE = '<circle cx="24" cy="24" r="5" class="f"/><circle cx="40" cy="24" r="5" class="f"/><circle cx="32" cy="20" r="5.5" class="f"/><path d="M14 44c2-8 18-8 18-8s16 0 18 8" class="s"/>'
FUEL = '<rect x="18" y="16" width="20" height="32" rx="3" class="f"/><path d="M38 22l6 5v15a3 3 0 01-6 0v-8" class="s"/><rect x="22" y="20" width="12" height="8" rx="1.5" class="w"/>'
DOVE = '<path d="M14 36c8 0 12-6 16-12 4 6 10 8 20 6-4 6-10 10-18 10l-4 8-2-8c-5 0-9-2-12-4z" class="f"/><circle cx="44" cy="30" r="1.4" class="w"/>'
BOMB = '<circle cx="30" cy="36" r="13" class="f"/><path d="M38 24l5-5M43 19l3 1M43 19l-1-3" class="s"/><circle cx="26" cy="32" r="3" class="w"/>'
BUNKER = '<path d="M12 46h40M18 46V34a14 14 0 0128 0v12" class="s"/><path d="M32 10v14M27 19l5 5 5-5" class="s"/>'
MISSILE = '<path d="M14 50L44 20l6-6-1 9-29 30z" class="f"/><path d="M22 46l-6-2M24 48l2 6" class="s"/>'
NUKE = '<circle cx="32" cy="32" r="5" class="f"/><path d="M32 27l-6-11a18 18 0 0112 0zM36.5 34.5l12 0a18 18 0 01-6 10.5zM27.5 34.5l-6 10.5a18 18 0 01-6-10.5z" class="f"/>'
ATOM = '<ellipse cx="32" cy="32" rx="18" ry="7" class="s"/><ellipse cx="32" cy="32" rx="18" ry="7" transform="rotate(60 32 32)" class="s"/><ellipse cx="32" cy="32" rx="18" ry="7" transform="rotate(-60 32 32)" class="s"/><circle cx="32" cy="32" r="3.5" class="f"/>'
CARPET = '<circle cx="18" cy="38" r="6" class="f"/><circle cx="32" cy="38" r="6" class="f"/><circle cx="46" cy="38" r="6" class="f"/><path d="M12 22h40" class="s"/><path d="M18 22v10M32 22v10M46 22v10" class="s"/>'
BOLT = '<path d="M36 10L18 36h12l-4 18 20-28H34z" class="f"/>'
DIAMOND = '<path d="M20 22h24l8 10-20 22-20-22z" class="f"/><path d="M12 32h40M26 22l6 32 6-32" class="s"/>'
HOURGLASS = '<path d="M20 12h24M20 52h24M22 12c0 12 10 14 10 20s-10 8-10 20M42 12c0 12-10 14-10 20s10 8 10 20" class="s"/><path d="M26 46h12l-6-6z" class="f"/>'
ROUNDTRIP = '<path d="M18 32a14 14 0 0124-10M46 32a14 14 0 01-24 10" class="s"/><path d="M42 14v8h-8M22 50v-8h8" class="s"/>'
SEAT = '<path d="M22 14v22h22v14M22 36l-4 14M44 36h-22" class="s"/><rect x="22" y="14" width="6" height="22" rx="2" class="f"/>'
COIN = '<circle cx="32" cy="32" r="16" class="f"/><circle cx="32" cy="32" r="11" class="s"/><path d="M32 24v16M28 28h6a2 2 0 010 4h-4a2 2 0 000 4h6" class="sd"/>'
REDEEM = '<path d="M32 50l-14-14a8 8 0 0114-8 8 8 0 0114 8z" class="f"/><path d="M26 34l5 5 9-10" class="sd"/>'
PAD = '<path d="M14 50h36M20 50l4-8h16l4 8" class="s"/><path d="M32 12c5 4 6 10 5.5 18H26.5C26 22 27 16 32 12z" class="f"/><path d="M28 34l4 7 4-7" class="flame"/>'
GRADCAP = '<path d="M10 26l22-10 22 10-22 10z" class="f"/><path d="M20 30v10c4 4 20 4 24 0V30M50 28v12" class="s"/>'
SERIAL = '<g transform="translate(-10 4) scale(.8)"><path d="M32 12c7 6 9 15 8 25l-4 6h-8l-4-6c-1-10 1-19 8-25z" class="f"/></g><g transform="translate(14 4) scale(.8)"><path d="M32 12c7 6 9 15 8 25l-4 6h-8l-4-6c-1-10 1-19 8-25z" class="f"/></g><g transform="translate(2 -4) scale(.8)"><path d="M32 12c7 6 9 15 8 25l-4 6h-8l-4-6c-1-10 1-19 8-25z" class="f"/></g>'
SHOVEL = '<path d="M44 14l6 6-16 16" class="s"/><path d="M34 36l-6-6-12 12a6 6 0 008 8z" class="f"/>'
FLIP = '<path d="M16 24h28l-6-6M48 40H20l6 6" class="s"/><circle cx="32" cy="32" r="3" class="f"/>'
SCOPE = '<circle cx="32" cy="32" r="15" class="s"/><path d="M32 10v12M32 42v12M10 32h12M42 32h12" class="s"/><circle cx="32" cy="32" r="3" class="f"/>'
PASSPORT = '<rect x="18" y="12" width="28" height="40" rx="4" class="f"/><circle cx="32" cy="28" r="6" class="sd"/><path d="M24 42h16" class="sd"/>'
APE = '<circle cx="32" cy="32" r="14" class="f"/><circle cx="16" cy="30" r="4" class="f"/><circle cx="48" cy="30" r="4" class="f"/><circle cx="27" cy="29" r="2" class="d"/><circle cx="37" cy="29" r="2" class="d"/><path d="M26 38c4 3 8 3 12 0" class="sd"/>'
CHEVRON1 = '<path d="M18 38l14-10 14 10" class="s"/>'
CHEVRON2 = '<path d="M18 34l14-10 14 10M18 44l14-10 14 10" class="s"/>'
CHEVRON3 = '<path d="M18 30l14-10 14 10M18 40l14-10 14 10M18 50l14-10 14 10" class="s"/>'
CHOIR = '<path d="M32 12v40" class="s"/><path d="M20 22c4 0 8-4 12-10 4 6 8 10 12 10-2 14-8 22-12 28-4-6-10-14-12-28z" class="f"/>'
STACK = '<ellipse cx="32" cy="44" rx="14" ry="4" class="f"/><ellipse cx="32" cy="36" rx="14" ry="4" class="f"/><ellipse cx="32" cy="28" rx="14" ry="4" class="f"/><ellipse cx="32" cy="18" rx="9" ry="3" class="s"/>'
TRAMP = '<path d="M12 40c8 8 32 8 40 0M14 40v10M50 40v10" class="s"/><path d="M32 12c4 3 5 8 4.5 14h-9C27 20 28 15 32 12z" class="f"/><path d="M28 30l-2 4M36 30l2 4" class="s"/>'
NET = '<path d="M12 30c10 14 30 14 40 0M12 30l10 18M52 30l-10 18M22 34l10 16 10-16M32 34v16" class="s"/><path d="M32 12v10" class="s"/>'
WALL = '<path d="M12 22h40v28H12zM12 31h40M12 40h40M22 22v9M38 22v9M30 31v9M46 31v9M20 40v10M40 40v10" class="s"/><path d="M28 12l8 8-8 2z" class="f"/>'
BRICKS = '<rect x="12" y="20" width="18" height="9" rx="1" class="f"/><rect x="34" y="20" width="18" height="9" rx="1" class="f"/><rect x="22" y="32" width="20" height="9" rx="1" class="f"/><rect x="12" y="44" width="18" height="8" rx="1" class="f"/><rect x="34" y="44" width="18" height="8" rx="1" class="f"/><path d="M38 10l6 6" class="s"/>'
SHIELD = '<path d="M32 10l18 6v14c0 12-8 20-18 24-10-4-18-12-18-24V16z" class="f"/><path d="M24 32l6 6 10-12" class="sd"/>'

def txt(t, y=60, size=10):
    return f'<text x="32" y="{y}" text-anchor="middle" class="t" font-size="{size}">{t}</text>'

G = {
 "first_blessing": ROCKET + HALO,
 "final_boost": FUEL + GATE,   # placeholder (BRAND)
 "through_pearly_gates": GATE,
 "seventh_heaven": CLOUD + '<text x="32" y="30" text-anchor="middle" class="t" font-size="16">VII</text>',
 "narrow_gate": '<path d="M26 50V24a6 6 0 0112 0v26" class="s"/><path d="M14 50h36" class="s"/>' + HALO,
 "firmament_walker": STAR + '<circle cx="14" cy="16" r="1.6" class="w"/><circle cx="50" cy="50" r="1.6" class="w"/><circle cx="52" cy="16" r="1.2" class="w"/>',
 "angel_altitude": WINGS + HALO + '<path d="M32 22v20" class="s"/>',
 "seraphim_sight": '<path d="M32 22c-10 0-18 10-18 10s8 10 18 10 18-10 18-10-8-10-18-10z" class="f"/><circle cx="32" cy="32" r="5" class="d"/>' + '<path d="M10 20l8 6M54 20l-8 6M10 44l8-6M54 44l-8-6" class="s"/>',
 "tier_tourist": '<path d="M12 18l13-4 14 4 13-4v32l-13 4-14-4-13 4z" class="f"/><path d="M25 14v32M39 18v32" class="sd"/>',
 "best_x_10": CHART + txt("10×", 58, 11),
 "best_x_50": CHART + txt("50×", 58, 11) + '<circle cx="48" cy="20" r="3" class="w"/>',
 "crew_captain_ach": CROWN,
 "gate_keeper_ach": KEY,
 "choir_of_three": PEOPLE,
 "full_congregation": PEOPLE + '<circle cx="14" cy="30" r="4" class="f"/><circle cx="50" cy="30" r="4" class="f"/>',
 "co_fueler": FUEL,
 "ascension_assist": DOVE,
 "first_grenade": BOMB,
 "bunker_buster_ach": BUNKER,
 "cruise_missile_ach": MISSILE,
 "nuke_ach": NUKE,
 "atom_bomber": ATOM,
 "carpet_bomber": CARPET,
 "shock_and_awe": BOLT,
 "diamond_halo": DIAMOND + HALO,
 "believer_badge": HOURGLASS,
 "round_tripper": ROUNDTRIP,
 "iron_seat": SEAT,
 "unfumbled": COIN,
 "bag_redemption": REDEEM,
 "pad_ignition": PAD,
 "graduated_dev": GRADCAP,
 "serial_launcher": SERIAL,
 "kingmaker_ach": CROWN + '<circle cx="32" cy="34" r="3" class="d"/>' + txt("2", 60, 9),
 "trench_warfare": SHOVEL,
 "flip_artist": FLIP,
 "sniper_nest": SCOPE,
 "degen_passport": PASSPORT,
 "ape_awakening": APE,
 "season_initiate": CHEVRON1,
 "season_blessed": CHEVRON2,
 "season_anointed": CHEVRON3,
 "top_percentile": CHOIR,
 "rhalo_stacker": STACK,
 "first_bounce": TRAMP,
 "trampoline_saint": TRAMP + HALO,
 "holy_safety_net": NET,
 "wall_of_jericho": WALL,
 "stonemason": BRICKS,
 "gatekeeper_of_range": SHIELD,
 "pass_level_25": '<text x="32" y="40" text-anchor="middle" class="t" font-size="20">25</text>' + HALO,
}

def svg(aid, rarity, glyph):
    hi, lo = RING[rarity]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="{aid}">
<defs>
<radialGradient id="bg" cx="50%" cy="38%" r="65%"><stop offset="0" stop-color="#26306a"/><stop offset=".7" stop-color="#121634"/><stop offset="1" stop-color="#080a18"/></radialGradient>
<linearGradient id="ring" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{hi}"/><stop offset=".5" stop-color="{lo}"/><stop offset="1" stop-color="{hi}"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff7df"/><stop offset=".55" stop-color="#ffe7a3"/><stop offset="1" stop-color="#d9a640"/></linearGradient>
<radialGradient id="glow" cx="50%" cy="45%" r="50%"><stop offset="0" stop-color="#ffe7a3" stop-opacity=".28"/><stop offset="1" stop-color="#ffe7a3" stop-opacity="0"/></radialGradient>
</defs>
<style>.s{{fill:none;stroke:url(#gold);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}}.f{{fill:url(#gold);stroke:#8a6420;stroke-width:.8;stroke-linejoin:round}}.w{{fill:#9fd0ff}}.d{{fill:#121634}}.sd{{fill:none;stroke:#121634;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}}.flame{{fill:#ffb36b;stroke:#ff7e5f;stroke-width:1}}.t{{fill:url(#gold);font-family:Georgia,serif;font-weight:700}}</style>
<circle cx="32" cy="32" r="30" fill="url(#ring)"/>
<circle cx="32" cy="32" r="26.5" fill="url(#bg)" stroke="#05060c" stroke-width="1"/>
<circle cx="32" cy="32" r="24" fill="url(#glow)"/>
<g transform="translate(32 32) scale(.78) translate(-32 -32)">{glyph}</g>
<path d="M14 20a22 22 0 0136 0" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="2"/>
</svg>
'''

out = os.path.join(ROOT, "public/achievements")
os.makedirs(out, exist_ok=True)
missing = [a for a, _, _ in ach if a not in G]
assert not missing, f"no glyph for {missing}"
for aid, _cat, rarity in ach:
    open(os.path.join(out, f"{aid}.svg"), "w").write(svg(aid, rarity, G[aid]))
keep = {f"{a}.svg" for a, _, _ in ach}
for f in os.listdir(out):
    if f.endswith(".svg") and f not in keep:
        os.remove(os.path.join(out, f))  # drop icons for cut achievements
print(f"wrote {len(ach)} icons")

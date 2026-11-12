"""
Author the DISCIPLE chrome rocket (matches web/public/assets/rocket-hi.webp, 221x609 px) in Blender, bake
normal / roughness / metalness maps, export GLB.   Run:  blender -b --factory-startup --python build_rocket.py -- out.glb
Units: 1 sprite px = 1/609 m (whole sprite = 1 m tall). Origin = nozzle pivot (0.96 of the sprite height), Z up
(the glTF exporter converts to Y up).
"""
import bpy, bmesh, math, sys
from mathutils import Vector, Matrix

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "/tmp/rocket.glb"
RES_N = 2048; RES_ORM = 1024
S = 1.0 / 609.0
PIV = 0.96 * 609
def Z(row): return (PIV - row) * S
def R(px): return px * S

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def link(obj):
    scene.collection.objects.link(obj); return obj

def catmull(pts, n):
    """Catmull-Rom through (row, r) points, n samples per segment."""
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n; t2 = t * t; t3 = t2 * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(2)))
    out.append(pts[-1]); return out

def lathe(name, prof, segs=128):
    """prof: list of (row, halfwidth px) top -> bottom; spun around Z."""
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    rings = []
    for (row, hw) in prof:
        ring = []
        for s in range(segs):
            a = 2 * math.pi * s / segs
            ring.append(bm.verts.new((R(hw) * math.cos(a), R(hw) * math.sin(a), Z(row))))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for s in range(segs):
            a, b = rings[i][s], rings[i][(s + 1) % segs]
            c, d = rings[i + 1][(s + 1) % segs], rings[i + 1][s]
            try: bm.faces.new((a, d, c, b))
            except ValueError: pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(me); bm.free()
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons: p.use_smooth = True
    return ob

# ---------------- r2: silhouette traced from the official sprite's alpha (centre column x = 110.5; rows measured)
def interp(tab, x):
    """piecewise-linear lookup in [(x, y), ...] (x ascending)"""
    if x <= tab[0][0]: return tab[0][1]
    for (x0, y0), (x1, y1) in zip(tab, tab[1:]):
        if x <= x1: return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return tab[-1][1]

# ---------------- hull: conical-ogive nose (traced), shoulder, straight body, boat-tail
nose = catmull([(2, 0.0), (6, 5.5), (12, 9.5), (18, 12.5), (24, 15.0), (30, 17.5), (36, 20.3), (42, 22.6), (48, 24.8), (54, 27.3),
                (60, 29.5), (72, 33.5), (84, 37.3), (96, 40.6), (108, 43.6), (112, 44.5)], 4)
nose[0] = (2.0, 0.0)
body_prof = nose + [(116, 45.6), (122, 46.5), (130, 47.2), (140, 47.5), (176, 47.6), (186, 48.5), (330, 48.5), (538, 48.5)] \
    + catmull([(538, 48.5), (546, 47.4), (552, 43.0), (558, 38.8), (564, 34.5), (568, 30.5)], 4)[1:] + [(569, 20.0), (569.5, 0.0)]
BANDS = (112.0, 181.0)

def hull_eps(row, a):
    """A very slight, broad, smooth departure from a perfect circle (no flutes, no grooves): a few LOW harmonics
    (3, 5, 7 lobes) of well under 1 % of the radius. Max surface tilt ~5 deg, so the reflected sky breaks into more
    bands than a pure cylinder shows, and the bands travel when the ship rolls. Faded out at the nose tip, at the
    two shoulder rings and on the boat-tail so those stay round."""
    fade = min(1.0, max(0.0, (row - 14) / 40.0))
    for bnd in BANDS: fade *= min(1.0, abs(row - bnd) / 9.0) ** 2 if abs(row - bnd) < 9 else 1.0
    if row > 536: fade *= max(0.0, 1.0 - (row - 536) / 14.0)
    return fade * (0.022 * math.cos(3 * a + 0.4) + 0.016 * math.cos(5 * a + 2.1) + 0.010 * math.cos(7 * a + 4.0))

def lathe_eps(name, prof, segs):
    me = bpy.data.meshes.new(name); bm = bmesh.new(); rings = []
    for (row, hw) in prof:
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs; r = R(hw) * (1 + hull_eps(row, a))
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), Z(row))))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(segs):
            try: bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][(k + 1) % segs], rings[i][(k + 1) % segs]))
            except ValueError: pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(me); bm.free()
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons: p.use_smooth = True
    return ob
# densify the long straight body so the broad lobes stay smooth along the length
dense = []
for (r0, h0), (r1, h1) in zip(body_prof, body_prof[1:]):
    n = max(1, int(abs(r1 - r0) / 6))
    for k in range(n): dense.append((r0 + (r1 - r0) * k / n, h0 + (h1 - h0) * k / n))
dense.append(body_prof[-1])
hull = lathe_eps("Hull", dense, 256)

# ---------------- the two shoulder rings (round, raised)
def band(row, rad, h, name):
    prof = [(row - h, rad - 0.3), (row - h * 0.8, rad + 1.3), (row - h * 0.3, rad + 2.0), (row + h * 0.3, rad + 2.0), (row + h * 0.8, rad + 1.3), (row + h, rad - 0.3)]
    return lathe(name, prof, 192)
band1 = band(BANDS[0], 44.5, 3.4, "BandUpper")
band2 = band(BANDS[1], 47.9, 3.6, "BandLower")

# ---------------- fins (traced): long swept leading edge, vertical outer edge, sharp bottom tip, and a trailing edge that
# curves INWARD to meet the body. Built as a thin airfoil-like shell (no flat card) with a gentle compound curve
# (chordwise bow + spanwise curl + a little twist) so the reflections break into many thin streaks. No grooves.
LEAD = [(43.0, 321.0), (48.5, 330.0), (70.0, 374.0), (90.0, 414.0), (104.0, 444.0), (107.5, 452.0), (108.5, 460.0)]
TRAIL = [(43.0, 527.0), (48.5, 531.0), (54.0, 535.0), (60.0, 538.0), (65.5, 541.0), (72.0, 546.0), (78.5, 552.0), (89.5, 564.0),
         (99.5, 576.0), (103.5, 581.5), (105.5, 582.5), (107.5, 580.0), (108.5, 574.0)]
H_ROOT, H_TIP = 43.0, 108.5
def fin(angle, name, NS=56, NT=72):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    top, bot = [], []
    for i in range(NS + 1):
        s = i / NS; h = H_ROOT + (H_TIP - H_ROOT) * (1 - (1 - s) ** 1.3)   # denser near the tip
        lr, tr = interp(LEAD, h), interp(TRAIL, h)
        rt, rb = [], []
        for j in range(NT + 1):
            t = 0.5 - 0.5 * math.cos(math.pi * j / NT)                        # cosine spacing: fine at both edges
            row = lr + (tr - lr) * t
            th0 = 6.0 * (1 - 0.5 * s)                                          # px: thick at the root, thinner outboard
            edge = math.sin(math.pi * t) ** 0.5 * (1 - s ** 8) ** 0.5          # rounded leading/trailing/outer edges
            # a soft, rounded rim along the leading and outer edges (the official fins read thick-edged); smooth, not a groove
            rim = 2.4 * math.exp(-((t - 0.07) / 0.06) ** 2) + 2.0 * math.exp(-((s - 0.93) / 0.05) ** 2) * math.sin(math.pi * t) ** 0.3
            half = 0.5 * (th0 + rim) * edge
            # compound curve: chordwise bow that grows outboard, spanwise curl, a little twist and a gentle S along the chord,
            # so the fin is doubly curved everywhere and the reflections break into many thin streaks
            camber = (4.6 * math.sin(math.pi * t) * s ** 1.1 + 3.6 * s * s + 4.2 * (t - 0.5) * s
                      - 2.2 * math.sin(2 * math.pi * t) * s * (1 - 0.5 * s))
            x, z = R(h), Z(row)
            if half < 1e-4:
                v = bm.verts.new((x, R(camber), z)); rt.append(v); rb.append(v)
            else:
                rt.append(bm.verts.new((x, R(camber + half), z))); rb.append(bm.verts.new((x, R(camber - half), z)))
        top.append(rt); bot.append(rb)
    for i in range(NS):
        for j in range(NT):
            for G, flip in ((top, False), (bot, True)):
                q = [G[i][j], G[i + 1][j], G[i + 1][j + 1], G[i][j + 1]]
                if flip: q.reverse()
                q2 = []
                for v in q:
                    if v not in q2: q2.append(v)
                if len(q2) >= 3:
                    try: bm.faces.new(q2)
                    except ValueError: pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons: p.use_smooth = True
    ob.rotation_euler = (0, 0, angle)
    return ob
fins = [fin(math.pi / 2 * k, f"Fin{k}") for k in range(4)]

# ---------------- engine (traced): a short ring stack on the boat-tail, FOUR nozzle bells in a ring (in line with the
# fins, so the sprite's front view shows three), and the long centre spike.
def torus(name, row, major, minor):
    bpy.ops.mesh.primitive_torus_add(major_segments=128, minor_segments=24, major_radius=R(major), minor_radius=R(minor), location=(0, 0, Z(row)))
    ob = bpy.context.active_object; ob.name = name
    for p in ob.data.polygons: p.use_smooth = True
    return ob
rings = [torus("Ring0", 554.0, 43.0, 3.2), torus("Ring1", 563.0, 37.5, 3.6), torus("Ring2", 572.0, 31.0, 3.8)]
def nozzle(name, x, y):
    prof = [(566.0, 4.6), (572.0, 5.0), (577.0, 5.6), (582.0, 6.6), (586.0, 7.4), (588.0, 7.7), (589.5, 7.1), (588.0, 6.2), (582.0, 5.0), (574.0, 4.0)]
    ob = lathe(name, prof, 48); ob.location = (R(x), R(y), 0); return ob
pins = [nozzle(f"Nozzle{k}", 23.5 * math.cos(math.pi / 2 * k), 23.5 * math.sin(math.pi / 2 * k)) for k in range(4)]
spike = lathe("Spike", [(562.0, 0.0), (563.0, 3.0), (566.0, 4.5)] + [(r, 4.5) for r in range(570, 602, 4)]
              + [(602.0, 4.5), (604.5, 3.8), (606.2, 2.4), (607.0, 0.0)], 48)
# ---------------- apply modifiers, join, UV
objs = [o for o in scene.objects if o.type == "MESH"]
for o in objs:
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    o.select_set(False)
# remember which faces are engine parts: tag them through a face map attribute before joining
for o in objs:
    a = o.data.attributes.new("is_engine", "INT", "FACE")
    v = 1 if o.name in {"Ring1", "Ring2", "Nozzle0", "Nozzle1", "Nozzle2", "Nozzle3"} else 0
    for k in range(len(o.data.polygons)): a.data[k].value = v
for o in objs: o.select_set(True)
bpy.context.view_layer.objects.active = hull
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.ops.object.join()
rocket = bpy.context.active_object; rocket.name = "DiscipleRocket"
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.object.shade_auto_smooth(angle=math.radians(80)) if hasattr(bpy.ops.object, "shade_auto_smooth") else None
print("tris", sum(len(p.vertices) - 2 for p in rocket.data.polygons))

# ---------------- materials: one continuous mirror chrome; the engine bell a darker, rougher metal
def make_mat(name, base, r_lo, r_hi, bump_strength):
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    nt = mat.node_tree; N = nt.nodes; L = nt.links
    for n in list(N): N.remove(n)
    out = N.new("ShaderNodeOutputMaterial"); bsdf = N.new("ShaderNodeBsdfPrincipled"); L.new(bsdf.outputs[0], out.inputs[0])
    tc = N.new("ShaderNodeTexCoord")
    nz = N.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 4.0; nz.inputs["Detail"].default_value = 2.0
    L.new(tc.outputs["Object"], nz.inputs["Vector"])
    sm = N.new("ShaderNodeTexNoise"); sm.inputs["Scale"].default_value = 45.0; sm.inputs["Detail"].default_value = 6.0
    L.new(tc.outputs["Object"], sm.inputs["Vector"])
    # only a whisper of large-scale polish waviness in the normal map (no grooves, no flutes, no seams)
    bump = N.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = bump_strength; bump.inputs["Distance"].default_value = 0.002
    L.new(nz.outputs["Fac"], bump.inputs["Height"]); L.new(bump.outputs[0], bsdf.inputs["Normal"])
    rr = N.new("ShaderNodeMapRange"); rr.inputs["From Min"].default_value = 0.3; rr.inputs["From Max"].default_value = 0.75
    rr.inputs["To Min"].default_value = r_lo; rr.inputs["To Max"].default_value = r_hi
    L.new(sm.outputs["Fac"], rr.inputs["Value"]); L.new(rr.outputs["Result"], bsdf.inputs["Roughness"])
    mv = N.new("ShaderNodeValue"); mv.outputs[0].default_value = 1.0; L.new(mv.outputs[0], bsdf.inputs["Metallic"])
    bsdf.inputs["Base Color"].default_value = base
    mat["rough_src"] = 1
    return mat, out, bsdf, rr, mv
CHROME = make_mat("Chrome", (0.97, 0.972, 0.98, 1), 0.012, 0.02, 0.008)
ENGINE = make_mat("EngineMetal", (0.62, 0.63, 0.66, 1), 0.1, 0.16, 0.03)
rocket.data.materials.clear()
rocket.data.materials.append(CHROME[0]); rocket.data.materials.append(ENGINE[0])
ie = rocket.data.attributes['is_engine']
for p in rocket.data.polygons: p.material_index = 1 if ie.data[p.index].value else 0
rocket.data.attributes.remove(ie)
# ---------------- bake (both materials into the same atlas images)
scene.render.engine = "CYCLES"; scene.cycles.device = "CPU"; scene.cycles.samples = 16
scene.render.bake.margin = 8
def img(name, res):
    im = bpy.data.images.new(name, res, res, alpha=False, float_buffer=False); im.colorspace_settings.name = "Non-Color"; return im
MATS = [CHROME, ENGINE]
def bake(kind, im, which=None):
    tmp = []
    for (mat, out, bsdf, rr, mv) in MATS:
        N = mat.node_tree.nodes; L = mat.node_tree.links
        t = N.new("ShaderNodeTexImage"); t.image = im; N.active = t; t.select = True; tmp.append((mat, t, None))
        if which:
            em = N.new("ShaderNodeEmission"); L.new((rr.outputs["Result"] if which == "rough" else mv.outputs[0]), em.inputs[0]); L.new(em.outputs[0], out.inputs[0]); tmp[-1] = (mat, t, em)
    bpy.context.view_layer.objects.active = rocket; rocket.select_set(True)
    if kind == "NORMAL": bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
    else: bpy.ops.object.bake(type="EMIT")
    for (mat, t, em), (_, out, bsdf, _, _) in zip(tmp, MATS):
        N = mat.node_tree.nodes; L = mat.node_tree.links
        if em: L.new(bsdf.outputs[0], out.inputs[0]); N.remove(em)
        N.remove(t)
nimg = img("rocket_normal", RES_N); bake("NORMAL", nimg)
rimg = img("rocket_rough", RES_ORM); bake("EMIT", rimg, "rough")
mimg = img("rocket_metal", RES_ORM); bake("EMIT", mimg, "metal")
import numpy as np
rp = np.array(rimg.pixels[:]).reshape(-1, 4); mp = np.array(mimg.pixels[:]).reshape(-1, 4)
orm = img("rocket_orm", RES_ORM); op = np.ones_like(rp); op[:, 1] = rp[:, 0]; op[:, 2] = mp[:, 0]
orm.pixels[:] = op.ravel().tolist(); orm.update()

# ---------------- export materials: image textures only (normal + ORM), per-material base colour
for (mat, out, bsdf, rr, mv), base in zip(MATS, [(0.97, 0.972, 0.98, 1), (0.62, 0.63, 0.66, 1)]):
    N = mat.node_tree.nodes; L = mat.node_tree.links
    for n in list(N): N.remove(n)
    out = N.new("ShaderNodeOutputMaterial"); bsdf = N.new("ShaderNodeBsdfPrincipled"); L.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs["Base Color"].default_value = base
    uv = N.new("ShaderNodeUVMap")
    tn = N.new("ShaderNodeTexImage"); tn.image = nimg; L.new(uv.outputs[0], tn.inputs[0])
    nm = N.new("ShaderNodeNormalMap"); L.new(tn.outputs["Color"], nm.inputs["Color"]); L.new(nm.outputs[0], bsdf.inputs["Normal"])
    to = N.new("ShaderNodeTexImage"); to.image = orm; L.new(uv.outputs[0], to.inputs[0])
    sc = N.new("ShaderNodeSeparateColor"); L.new(to.outputs["Color"], sc.inputs[0])
    L.new(sc.outputs["Green"], bsdf.inputs["Roughness"]); L.new(sc.outputs["Blue"], bsdf.inputs["Metallic"])
    mat.use_backface_culling = True

tri = rocket.modifiers.new("Tri", "TRIANGULATE")
bpy.ops.object.select_all(action="DESELECT"); rocket.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="AUTO",
                          export_yup=True, export_apply=True, export_tangents=True)
print("WROTE", OUT)

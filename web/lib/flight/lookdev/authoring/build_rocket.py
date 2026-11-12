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

# ---------------- hull: nose (smooth ogive) + straight body + boat-tail
nose = catmull([(4, 0.0), (10, 5.0), (20, 13.5), (40, 22.0), (60, 29.5), (80, 36.0), (100, 41.5), (112, 44.6)], 6)
nose[0] = (4.0, 0.0)
body_prof = nose + [(118, 45.6), (140, 47.4), (176, 48.5), (330, 48.5), (556, 48.5)] + catmull([(556, 48.5), (566, 46.5), (572, 42.5), (576, 34.0), (577, 26.0)], 4)[1:] + [(577.5, 0.0)]
hull = lathe("Hull", body_prof, 160)

# ---------------- two raised hull bands (crisp highlight lines in the art)
def band(row, rad, h, name):
    prof = [(row - h, rad - 0.2), (row - h * 0.8, rad + 1.4), (row - h * 0.3, rad + 2.1), (row + h * 0.3, rad + 2.1), (row + h * 0.8, rad + 1.4), (row + h, rad - 0.2)]
    return lathe(name, prof, 160)
band1 = band(114.5, 45.0, 3.6, "BandUpper")
band2 = band(180.5, 48.5, 3.6, "BandLower")

# ---------------- fins: swept, rounded slab with a raised rim, a little curvature so reflections flow
def fin(angle, name):
    outline = [(47.0, 330), (78.0, 400), (104.0, 455), (109.0, 470), (110.0, 560), (106.0, 568), (90.0, 556), (70.0, 545), (47.0, 540)]
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new((R(x), 0.0, Z(row))) for (x, row) in outline]
    f = bm.faces.new(vs)
    bmesh.ops.triangulate(bm, faces=[f]) if False else None
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    vv = [e for e in ext["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=vv, vec=(0, R(5.0), 0))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, -R(2.5), 0))
    bm.to_mesh(me); bm.free()
    ob = link(bpy.data.objects.new(name, me))
    bev = ob.modifiers.new("bev", "BEVEL"); bev.width = R(1.8); bev.segments = 3; bev.limit_method = "ANGLE"
    sub = ob.modifiers.new("sub", "SUBSURF"); sub.levels = 2; sub.render_levels = 2
    bend = ob.modifiers.new("bend", "SIMPLE_DEFORM"); bend.deform_method = "BEND"; bend.angle = math.radians(6); bend.deform_axis = "Z"
    for p in me.polygons: p.use_smooth = True
    ob.rotation_euler = (0, 0, angle)
    return ob

fins = [fin(math.pi / 2 * k, f"Fin{k}") for k in range(4)]

# ---------------- root fairings: long teardrops along each fin root (the art's tapered ridges on the lower hull)
def fairing(angle, name):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=1.0)
    ob = bpy.context.active_object; ob.name = name
    zc = (Z(318) + Z(552)) / 2; L = (Z(318) - Z(552)) / 2
    ob.scale = (R(9.0), R(7.0), L)
    # teardrop: pinch the top
    me = ob.data
    for v in me.vertices:
        t = (v.co.z + 1) / 2          # 0 bottom .. 1 top
        k = 1.0 - 0.75 * t ** 1.6
        v.co.x *= k; v.co.y *= k
    ob.location = (R(47.5) * math.cos(angle), R(47.5) * math.sin(angle), zc)
    ob.rotation_euler = (0, 0, angle)
    for p in me.polygons: p.use_smooth = True
    return ob

fairs = []   # no fairing / flute / groove geometry: the art's bands are reflections on smooth chrome

# ---------------- engine: stacked manifold rings, bell, nozzle pins and the fin rods
def torus(name, row, major, minor):
    bpy.ops.mesh.primitive_torus_add(major_segments=96, minor_segments=20, major_radius=R(major), minor_radius=R(minor), location=(0, 0, Z(row)))
    ob = bpy.context.active_object; ob.name = name
    for p in ob.data.polygons: p.use_smooth = True
    return ob
rings = [torus("Ring0", 563, 45.0, 3.0), torus("Ring1", 570, 40.0, 3.0), torus("Ring2", 577, 33.0, 3.0)]
bell = lathe("Bell", [(574, 18.0), (580, 21.0), (588, 25.0), (596, 29.0), (597, 27.5), (589, 23.5), (581, 19.5), (576, 17.0)], 96)
def pin(name, x, y, r, top, bot):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=R(r), depth=Z(top) - Z(bot), location=(R(x), R(y), (Z(top) + Z(bot)) / 2))
    ob = bpy.context.active_object; ob.name = name
    bev = ob.modifiers.new("bev", "BEVEL"); bev.width = R(r * 0.45); bev.segments = 4
    for p in ob.data.polygons: p.use_smooth = True
    return ob
pins = []
for k in range(4):
    a = math.pi / 4 + math.pi / 2 * k
    pins.append(pin(f"Nozzle{k}", 30 * math.cos(a), 30 * math.sin(a), 5.0, 572, 596))
for k in range(4):
    a = math.pi / 2 * k
    pins.append(pin(f"Rod{k}", 52 * math.cos(a), 52 * math.sin(a), 2.4, 530, 606))

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
    v = 1 if o.name in {"Bell", "Ring0", "Ring1", "Ring2", "Nozzle0", "Nozzle1", "Nozzle2", "Nozzle3"} else 0
    for k in range(len(o.data.polygons)): a.data[k].value = v
for o in objs: o.select_set(True)
bpy.context.view_layer.objects.active = hull
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.ops.object.join()
rocket = bpy.context.active_object; rocket.name = "DiscipleRocket"
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.object.shade_auto_smooth(angle=math.radians(50)) if hasattr(bpy.ops.object, "shade_auto_smooth") else None
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
CHROME = make_mat("Chrome", (0.96, 0.965, 0.975, 1), 0.035, 0.045, 0.02)
ENGINE = make_mat("EngineMetal", (0.55, 0.56, 0.6, 1), 0.2, 0.3, 0.06)
engine_names = {"Bell", "Ring0", "Ring1", "Ring2", "Nozzle0", "Nozzle1", "Nozzle2", "Nozzle3"}
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
for (mat, out, bsdf, rr, mv), base in zip(MATS, [(0.96, 0.965, 0.975, 1), (0.55, 0.56, 0.6, 1)]):
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

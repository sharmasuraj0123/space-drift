"""Author and export the original low-poly meshes used inside Space Drift.

Run: blender --background --python scripts/create-game-assets.py
Outputs: an embedded GLB, editable Blender source, measured asset manifest, and
a local contact-sheet render in the ignored artifacts directory. No downloads.

Blender +Y becomes glTF -Z, so the explorer is modeled nose-first along +Y.
The other assets fit within a unit sphere and all export with identity transforms.
"""

from pathlib import Path
import json
import math
import random
import re

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "source"
MODELS = ROOT / "public" / "assets" / "models"
ARTIFACTS = ROOT / "artifacts"
for folder in (SOURCE, MODELS, ARTIFACTS):
    folder.mkdir(parents=True, exist_ok=True)
styles = (ROOT / "public" / "styles.css").read_text(encoding="utf-8")


def color(hex_color):
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in channels) + (1,)


def token(name, fallback):
    match = re.search(r"--" + re.escape(name) + r"\s*:\s*#([\da-fA-F]{6})(?=[;\s}])", styles)
    return match.group(1) if match else fallback


PALETTE = {
    "pearl": "e5eaff", "navy": "162039", "graphite": "101828",
    "accent": token("accent", "aab8ff"), "cyan": token("cyan", "68e4ef"),
    "coral": token("coral", "ffad9b"), "lilac": token("lilac", "c4a5ff"),
    "steel": "526680", "ocean": "264a74", "ice": "c3dce7",
}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "Game assets — export at origin"


def mat(name, tint, metal=.1, rough=.5, emission=0, vertex=False):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color(tint)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color(tint)
    shader.inputs["Metallic"].default_value = metal
    shader.inputs["Roughness"].default_value = rough
    if emission:
        shader.inputs["Emission Color"].default_value = color(tint)
        shader.inputs["Emission Strength"].default_value = emission
    if vertex:
        attr = material.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Color"
        material.node_tree.links.new(attr.outputs["Color"], shader.inputs["Base Color"])
    return material


materials = {
    "ceramic": mat("Explorer · pearl ceramic", PALETTE["pearl"], .25, .39),
    "alloy": mat("Explorer · periwinkle alloy", PALETTE["accent"], .58, .38),
    "graphite": mat("Explorer · graphite recesses", PALETTE["graphite"], .42, .49),
    "glass": mat("Explorer · smoked cockpit", "193b51", .5, .2),
    "cyan": mat("Explorer · cyan signal", PALETTE["cyan"], .12, .38, .4),
    "coral": mat("Explorer · coral identification", PALETTE["coral"], .1, .45),
    "matter": mat("Matter · vertex tint", "ffffff", .15, .58, vertex=True),
    "terrain": mat("Terrain · vertex tint", "ffffff", .12, .7, vertex=True),
    "cage": mat("Folder · periwinkle alloy", PALETTE["accent"], .35, .45),
}
roots = []


def mesh_object(name, verts, faces, material, parent=None, tint=None, smooth=False):
    mesh = bpy.data.meshes.new(name + " geometry")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    for face in mesh.polygons:
        face.use_smooth = smooth
    if tint:
        vertex_colors(obj, tint)
    return obj


def vertex_colors(obj, tint):
    attr = obj.data.color_attributes.get("Color")
    if attr is None:
        attr = obj.data.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    value = color(PALETTE.get(tint, tint)) if isinstance(tint, str) else tint
    for item in attr.data:
        item.color = value


def root(name, role):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj["assetRole"] = role
    obj["forward"] = "-Z" if name == "explorer" else "none"
    roots.append(obj)
    return obj


def descendants(obj):
    return [obj] + list(obj.children_recursive)


def prism(name, outline, low, high, material, parent, bevel=0):
    n = len(outline)
    verts = [(x, y, low) for x, y in outline] + [(x, y, high) for x, y in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    obj = mesh_object(name, verts, faces, material, parent)
    if bevel:
        mod = obj.modifiers.new("Manufactured edge bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        normal = obj.modifiers.new("Weighted panel normals", "WEIGHTED_NORMAL")
        bpy.ops.object.modifier_apply(modifier=normal.name)
    return obj


def ico(name, radius, location, material, parent, subdivisions=1, tint=None, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius)
    obj = bpy.context.object
    obj.name = name
    for vertex in obj.data.vertices:
        vertex.co = Vector((vertex.co.x * scale[0], vertex.co.y * scale[1], vertex.co.z * scale[2])) + Vector(location)
    obj.parent = parent
    obj.data.materials.append(material)
    if tint:
        vertex_colors(obj, tint)
    return obj


def uv_sphere(name, location, scale, material, parent, segments=16, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1)
    obj = bpy.context.object
    obj.name = name
    for v in obj.data.vertices:
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])) + Vector(location)
    obj.parent = parent
    obj.data.materials.append(material)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def tube(name, points, radius, material, parent, sides=4, closed=False, tint=None):
    points = [Vector(p) for p in points]
    count = len(points)
    verts = []
    for i, p in enumerate(points):
        before = points[(i - 1) % count] if closed or i else p
        after = points[(i + 1) % count] if closed or i < count - 1 else p
        tangent = (after - before).normalized()
        reference = Vector((0, 0, 1)) if abs(tangent.z) < .9 else Vector((0, 1, 0))
        normal = tangent.cross(reference).normalized()
        binormal = tangent.cross(normal).normalized()
        for j in range(sides):
            offset = normal * math.cos(j * math.tau / sides) + binormal * math.sin(j * math.tau / sides)
            verts.append(p + radius * offset)
    faces = []
    for i in range(count if closed else count - 1):
        for j in range(sides):
            faces.append((i * sides + j, i * sides + (j + 1) % sides,
                          ((i + 1) % count) * sides + (j + 1) % sides, ((i + 1) % count) * sides + j))
    if not closed:
        faces += [tuple(reversed(range(sides))), tuple(range((count - 1) * sides, count * sides))]
    return mesh_object(name, verts, faces, material, parent, tint)


def orbit(name, radius, material, parent, tilt=(0, 0, 0), steps=16, thickness=.04,
          tint=None, squash=1, phase=0, span=math.tau, center=(0, 0, 0), sides=3):
    rotation = Matrix.Rotation(tilt[2], 4, "Z") @ Matrix.Rotation(tilt[1], 4, "Y") @ Matrix.Rotation(tilt[0], 4, "X")
    closed = math.isclose(span, math.tau)
    points = []
    for i in range(steps if closed else steps + 1):
        angle = phase + span * i / steps
        p = rotation @ Vector((math.cos(angle) * radius, math.sin(angle) * radius * squash, 0))
        points.append(p + Vector(center))
    return tube(name, points, thickness, material, parent, sides=sides, closed=closed, tint=tint)


def cylinder_y(name, x, y, z, radius, length, material, parent, segments=12):
    pts = [(x + math.cos(i * math.tau / segments) * radius,
            z + math.sin(i * math.tau / segments) * radius) for i in range(segments)]
    verts = [(px, y - length / 2, pz) for px, pz in pts] + [(px, y + length / 2, pz) for px, pz in pts]
    faces = [tuple(reversed(range(segments))), tuple(range(segments, segments * 2))]
    faces += [(i, (i + 1) % segments, (i + 1) % segments + segments, i + segments) for i in range(segments)]
    return mesh_object(name, verts, faces, material, parent)


def join_single(asset):
    pieces = [p for p in asset.children_recursive if p.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for piece in pieces:
        piece.select_set(True)
    bpy.context.view_layer.objects.active = pieces[0]
    if len(pieces) > 1:
        bpy.ops.object.join()
    mesh = bpy.context.object
    name = asset.name
    metadata = dict(asset.items())
    root_index = roots.index(asset)
    mesh.parent = None
    bpy.data.objects.remove(asset, do_unlink=True)
    mesh.name = name
    for key, value in metadata.items():
        mesh[key] = value
    # All input parts use the same vertex-color material, but join may retain slots.
    material = mesh.data.materials[0]
    mesh.data.materials.clear()
    mesh.data.materials.append(material)
    for face in mesh.data.polygons:
        face.material_index = 0
    roots[root_index] = mesh
    return mesh


def normalize(asset):
    meshes = [o for o in descendants(asset) if o.type == "MESH"]
    radius = max(v.co.length for o in meshes for v in o.data.vertices)
    for obj in meshes:
        for v in obj.data.vertices:
            v.co /= radius
    asset["boundingRadius"] = 1.0


# EXPLORER — compact ceramic hull, distinct swept wings, recessed panel work.
ship = root("explorer", "player-ship")
prism("explorer_hull", [(-1.04, -2.6), (1.04, -2.6), (1.1, .45), (.55, 3.5), (0, 5.1), (-.55, 3.5), (-1.1, .45)], -.12, .46, materials["ceramic"], ship, .12)
prism("explorer_keel", [(-.85, -2.68), (.85, -2.68), (.97, .2), (0, 4.96), (-.97, .2)], -.52, .06, materials["graphite"], ship, .1)
for side in (-1, 1):
    wing = [(side * .87, -2.4), (side * 4.7, -2.62), (side * 3.6, -.22), (side * .84, 2.55)]
    if side < 0:
        wing.reverse()
    prism(f"explorer_wing_{side}", wing, -.23, .04, materials["alloy"], ship, .1)
    recess = [(side * 1.6, -2.08), (side * 4.19, -2.2), (side * 3.37, -.46), (side * 1.6, 1.08)]
    if side < 0:
        recess.reverse()
    prism(f"explorer_wing_recess_{side}", recess, .04, .08, materials["graphite"], ship, .05)
    rail = [(side * 3.84, -2.03, .115), (side * 3.12, -.62, .115)]
    tube(f"explorer_wing_running_light_{side}", rail, .034, materials["cyan"], ship, sides=4)
    # Recessed ceramic rib breaks the wing into physical manufactured panels.
    tube(f"explorer_wing_rib_{side}", [(side * 1.5, -2.01, .11), (side * 3.27, -.51, .11)], .065, materials["alloy"], ship, sides=4)
    cylinder_y(f"explorer_engine_{side}", side * 1.58, -1.76, -.06, .43, 1.62, materials["graphite"], ship)
    cylinder_y(f"explorer_engine_shroud_{side}", side * 1.58, -1.67, -.06, .45, 1.1, materials["alloy"], ship)
    orbit(f"explorer_nozzle_rim_{side}", .325, materials["cyan"], ship, tilt=(math.pi / 2, 0, 0), steps=12, thickness=.055, center=(side * 1.58, -2.59, -.06), sides=4)
    cylinder_y(f"explorer_nozzle_interior_{side}", side * 1.58, -2.6, -.06, .24, .04, materials["graphite"], ship)
prism("explorer_cockpit_frame", [(-.59, -.02), (.59, -.02), (.46, 2.38), (0, 3.01), (-.46, 2.38)], .43, .57, materials["graphite"], ship, .09)
uv_sphere("explorer_cockpit", (0, 1.35, .59), (.48, 1.37, .48), materials["glass"], ship)
prism("explorer_aft_spine", [(-.22, -2.48), (.22, -2.48), (.26, -.27), (-.26, -.27)], .46, .66, materials["ceramic"], ship, .065)
for i in range(3):
    tube(f"explorer_aft_vent_{i}", [(-.55, -1.95 + i * .29, .485), (-.32, -1.95 + i * .29, .485)], .038, materials["graphite"], ship, sides=4)
tube("explorer_coral_identification", [(.48, -1.85, .49), (.48, -.9, .49)], .055, materials["coral"], ship, sides=4)
tube("explorer_nose_signal", [(-.13, 3.91, .465), (0, 4.25, .465), (.13, 3.91, .465)], .028, materials["cyan"], ship, sides=4)
ship["engineSockets"] = [[-1.58, -.06, 2.62], [1.58, -.06, 2.62]]
for name, x in (("thruster_left", -1.58), ("thruster_right", 1.58)):
    anchor = bpy.data.objects.new(name, None)
    scene.collection.objects.link(anchor)
    anchor.parent = ship
    anchor.location = (x, -2.62, -.06)
    anchor["assetRole"] = "live-thruster-socket"

# One draw call per material keeps the moving ship inexpensive to render.
for key in ("ceramic", "alloy", "graphite", "glass", "cyan", "coral"):
    pieces = [obj for obj in ship.children if obj.type == "MESH" and obj.data.materials[0] == materials[key]]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in pieces:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = pieces[0]
    if len(pieces) > 1:
        bpy.ops.object.join()
    bpy.context.object.name = "explorer_" + key


# PLANETS — geometric relief and colored geological regions, no image textures.
def field(v, seed):
    return (math.sin(v.x * 5.1 + seed) * math.cos(v.y * 4.3 - seed * .4)
            + .55 * math.sin(v.z * 7.5 + v.y * 2.1 + seed * .7)
            + .25 * math.cos(v.x * 11.1 - v.z * 4.5 + seed)) / 1.8


def planet(name, kind):
    parent = root(name, "repository-planet")
    obj = ico(name + "_terrain", 1, (0, 0, 0), materials["terrain"], parent, subdivisions=4)
    rng = random.Random(43 if kind == "basalt" else 87)
    craters = [(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized(), rng.uniform(.13, .31)) for _ in range(12)]
    directions = {v.index: v.co.normalized() for v in obj.data.vertices}
    for vertex in obj.data.vertices:
        v = directions[vertex.index]
        f = field(v, {"basalt": 2, "ocean": 5, "ice": 9}[kind])
        if kind == "basalt":
            h = .925 + .052 * f + .014 * abs(math.sin(v.x * 18 + v.z * 9))
            for center, size in craters:
                d = (v - center).length / size
                h += .028 * math.exp(-((d - 1) / .19) ** 2) - .032 * math.exp(-(d / .63) ** 4)
        elif kind == "ocean":
            h = .924 + (max(f, 0) * .086 + .015 if f > .06 else .0)
            if abs(v.z) > .82:
                h += .018
        else:
            h = .93 + .052 * abs(f) + .025 * abs(math.sin(v.x * 8 + v.y * 6 + v.z * 4))
        vertex.co = v * h
    obj.data.update()
    attr = obj.data.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    for face in obj.data.polygons:
        v = sum((directions[i] for i in face.vertices), Vector()).normalized()
        f = field(v, {"basalt": 2, "ocean": 5, "ice": 9}[kind])
        if kind == "basalt":
            tint = "3d4865" if f < -.15 else "596681" if f > .2 else "495671"
            if abs(math.sin(v.x * 18 + v.z * 9)) < .14:
                tint = "8290ab"
        elif kind == "ocean":
            tint = "2e567a" if f <= .06 else "8aa9af" if f < .32 else "aabac2"
            if abs(v.z) > .82:
                tint = "d4e3ed"
        else:
            tint = "d8e0ef" if f > .03 else "aebed8"
            if abs(math.sin(v.x * 8 + v.y * 6 + v.z * 4)) < .19:
                tint = "688eaf"
        base = color(tint)
        variation = 1 + rng.uniform(-.04, .04)
        value = tuple(c * variation for c in base[:3]) + (1,)
        for loop in face.loop_indices:
            attr.data[loop].color = value
    parent = join_single(parent)
    normalize(parent)


for planet_kind in ("basalt", "ocean", "ice"):
    planet("planet_" + planet_kind, planet_kind)


# ATOMS — one material and mesh each, ready to merge into InstancedMesh geometry.
def atom(name, kind):
    parent = root(name, "file-atom")
    tint = {"code": "accent", "data": "cyan", "document": "pearl", "media": "coral", "other": "lilac"}[kind]
    matter = materials["matter"]
    if kind == "code":
        ico(name + "_nucleus", .31, (0, 0, 0), matter, parent, tint=tint)
        orbit(name + "_orbit_a", .77, matter, parent, tilt=(.95, .4, .2), steps=12, thickness=.045, tint=tint)
        orbit(name + "_orbit_b", .77, matter, parent, tilt=(-.95, -.4, -.2), steps=12, thickness=.045, tint="steel")
        for i, location in enumerate(((.66, .34, .31), (-.67, -.34, -.29))):
            ico(name + f"_electron_{i}", .14, location, matter, parent, tint="pearl")
    elif kind == "data":
        ico(name + "_nucleus", .29, (0, 0, 0), matter, parent, tint="pearl", scale=(1, 1, 1.25))
        for i, z in enumerate((-.44, 0, .44)):
            orbit(name + f"_orbit_{i}", .62 if i != 1 else .77, matter, parent, steps=10, thickness=.047, tint=tint if i != 1 else "steel", center=(0, 0, z))
            ico(name + f"_electron_{i}", .12, ((.62 if i != 1 else -.77), 0, z), matter, parent, tint=tint)
    elif kind == "document":
        ico(name + "_nucleus", .36, (0, 0, 0), matter, parent, tint=tint, scale=(.62, .62, 1.32))
        orbit(name + "_vertical_orbit", .79, matter, parent, tilt=(math.pi / 2, .12, .32), steps=12, thickness=.047, tint=tint, squash=.82)
        orbit(name + "_equator", .63, matter, parent, tilt=(.16, .3, 0), steps=10, thickness=.04, tint="steel")
        for i, location in enumerate(((.28, .01, .72), (-.6, -.1, .1))):
            ico(name + f"_electron_{i}", .12, location, matter, parent, tint="accent")
    elif kind == "media":
        ico(name + "_nucleus", .3, (0, 0, 0), matter, parent, tint=tint)
        for i in range(3):
            angle = i * math.tau / 3
            orbit(name + f"_petal_{i}", .48, matter, parent, tilt=(.75, 0, angle), steps=10, thickness=.047, tint=tint if i != 1 else "steel", squash=.65,
                  center=(.28 * math.cos(angle), .28 * math.sin(angle), 0))
            ico(name + f"_electron_{i}", .12, (.72 * math.cos(angle), .72 * math.sin(angle), 0), matter, parent, tint="pearl")
    else:
        ico(name + "_nucleus", .33, (0, 0, 0), matter, parent, tint=tint, scale=(1, 1, .85))
        orbit(name + "_broad_orbit", .79, matter, parent, tilt=(.4, .4, .1), steps=16, thickness=.055, tint=tint, squash=.78)
        orbit(name + "_small_orbit", .57, matter, parent, tilt=(1.35, -.1, 0), steps=10, thickness=.035, tint="steel")
        for i, location in enumerate(((.73, .13, -.18), (-.49, -.51, -.06))):
            ico(name + f"_electron_{i}", .13, location, matter, parent, tint="pearl")
    parent = join_single(parent)
    normalize(parent)
    parent["fileKind"] = kind
    parent["instancing"] = "single mesh; single vertex-color material"


for atom_kind in ("code", "data", "document", "media", "other"):
    atom("atom_" + atom_kind, atom_kind)

# MOLECULE — an open architectural orbital cage; the runtime supplies its atoms.
cage = root("molecule", "folder-cage")
for i, tilt in enumerate(((.2, .15, .1), (1.3, .15, .7), (.25, 1.35, -.2))):
    orbit(f"molecule_open_arch_{i}", .92, materials["matter"], cage, tilt=tilt, steps=20, thickness=.033,
          tint="accent" if i != 1 else "steel", phase=.4 + i, span=math.tau * .81, sides=4)
for i, p in enumerate(((.89, .06, -.1), (-.62, .53, .49), (.05, -.44, -.81))):
    ico(f"molecule_joint_{i}", .07, p, materials["matter"], cage, tint="cyan")
cage = join_single(cage)
normalize(cage)

# ASTEROID — a craggy, asymmetric solid with readable fractured facets.
rock = root("asteroid", "space-debris")
rock_mesh = ico("asteroid_facets", 1, (0, 0, 0), materials["terrain"], rock, subdivisions=3, tint="steel")
rng = random.Random(951)
for v in rock_mesh.data.vertices:
    p = v.co.normalized()
    v.co *= .82 + .14 * field(p, 13) + rng.uniform(-.08, .07)
    v.co.x *= 1.18
    v.co.z *= .79
bpy.context.view_layer.objects.active = rock_mesh
decimate = rock_mesh.modifiers.new("Gameplay triangle budget", "DECIMATE")
decimate.ratio = .75
bpy.ops.object.modifier_apply(modifier=decimate.name)
rock = join_single(rock)
normalize(rock)


def gltf_vec(v):
    return [v.x, v.z, -v.y]


manifest = {"format": "glTF 2.0 binary", "up": "+Y", "shipForward": "-Z", "assets": {}}
for asset in roots:
    points = []
    triangles = 0
    meshes = [o for o in descendants(asset) if o.type == "MESH"]
    for obj in meshes:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
        points.extend(Vector(gltf_vec(v.co)) for v in obj.data.vertices)
    entry = {
        "triangles": triangles, "meshes": len(meshes),
        "bounds": {"min": [round(min(p[i] for p in points), 5) for i in range(3)],
                   "max": [round(max(p[i] for p in points), 5) for i in range(3)]},
        "radius": round(max(p.length for p in points), 6),
        "role": asset["assetRole"],
    }
    manifest["assets"][asset.name] = entry
    budget = 8000 if asset.name == "explorer" else 3000 if asset.name.startswith("planet") else 800 if asset.name == "molecule" else 300 if asset.name == "asteroid" else 600
    assert triangles <= budget, f"{asset.name} exceeds triangle budget: {triangles} > {budget}"
    if asset.name != "explorer":
        assert entry["radius"] <= 1.000001
    asset["triangles"] = triangles
    if asset.name.startswith("atom"):
        assert len(meshes) == 1 and len(meshes[0].data.materials) == 1
        assert meshes[0].data.color_attributes.get("Color") is not None

(SOURCE / "game-assets-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
bpy.ops.object.select_all(action="DESELECT")
for asset in roots:
    for obj in descendants(asset):
        obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(MODELS / "space-drift.glb"), export_format="GLB",
                          use_selection=True, export_yup=True, export_apply=True,
                          export_extras=True, export_texcoords=False,
                          export_cameras=False, export_lights=False)

# A second scene provides an editable studio contact sheet without changing exports.
preview = bpy.data.scenes.new("Contact sheet — original game meshes")
bpy.context.window.scene = preview
layout = {
    "explorer": ((-4.4, 0, 2.7), .68, (.2, -.12, -.36)),
    "planet_basalt": ((1.55, 0, 3.0), 1.3, (.2, .15, .4)),
    "planet_ocean": ((4.8, 0, 3.0), 1.3, (.2, .15, .4)),
    "planet_ice": ((8.05, 0, 3.0), 1.3, (.2, .15, .4)),
    "atom_code": ((-7, 0, -1.5), 1.1, (.1, .2, .1)),
    "atom_data": ((-3.8, 0, -1.5), 1.1, (.1, .2, .1)),
    "atom_document": ((-.6, 0, -1.5), 1.1, (.1, .2, .1)),
    "atom_media": ((2.6, 0, -1.5), 1.1, (.1, .2, .1)),
    "atom_other": ((5.8, 0, -1.5), 1.1, (.1, .2, .1)),
    "molecule": ((-3.0, 0, -5.2), 1.5, (.1, .2, .1)),
    "asteroid": ((2.3, 0, -5.2), 1.25, (.1, .2, .1)),
}
for asset in roots:
    location, scale, rotation = layout[asset.name]
    holder = bpy.data.objects.new("Preview " + asset.name, None)
    preview.collection.objects.link(holder)
    holder.location, holder.scale, holder.rotation_euler = location, (scale,) * 3, rotation
    for original in [o for o in descendants(asset) if o.type == "MESH"]:
        copy = bpy.data.objects.new("Preview " + original.name, original.data)
        preview.collection.objects.link(copy)
        copy.parent = holder


def area(name, location, energy, tint, size, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.color, data.shape, data.size = energy, color(tint)[:3], "DISK", size
    obj = bpy.data.objects.new(name, data)
    preview.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


area("Studio key", (-5, -8, 11), 2900, "e7edff", 10, (0, 0, 0))
area("Studio cyan edge", (10, 3, 7), 2200, "a3dfe8", 8, (0, 0, 0))
area("Studio fill", (0, -6, -4), 1000, "d5d7ff", 9, (0, 0, 0))
world = bpy.data.worlds.new("Midnight studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = color("25263a")
world.node_tree.nodes["Background"].inputs["Strength"].default_value = .6
preview.world = world
data = bpy.data.cameras.new("Contact sheet camera")
camera = bpy.data.objects.new("Contact sheet camera", data)
preview.collection.objects.link(camera)
camera.location = (0, -26, 13)
camera.rotation_euler = (Vector((0, 0, -.5)) - camera.location).to_track_quat("-Z", "Y").to_euler()
data.type, data.ortho_scale = "ORTHO", 21.5
preview.camera = camera
preview.render.engine = "CYCLES"
preview.cycles.samples = 48
preview.cycles.use_denoising = True
preview.render.resolution_x = 1600
preview.render.resolution_y = 1100
preview.render.resolution_percentage = 100
preview.render.image_settings.file_format = "PNG"
preview.render.image_settings.color_mode = "RGB"
preview.render.filepath = "//../../artifacts/game-assets-contact.png"
preview.view_settings.view_transform = "AgX"
preview.view_settings.look = "AgX - Medium High Contrast"
preview.view_settings.exposure = .6
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "game-assets.blend"), compress=True)
bpy.ops.render.render(write_still=True)
print("GAME_ASSET_MANIFEST", json.dumps(manifest))

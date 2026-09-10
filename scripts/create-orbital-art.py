"""Build Space Drift's original orbital illustration in Blender.

Run from any directory:
  blender --background --python scripts/create-orbital-art.py

Only built-in Blender geometry and materials are used. The scene, camera, lights,
and final web image are regenerated together; no external artwork is required.
"""

from pathlib import Path
import math
import random
import re

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "source"
PUBLIC = ROOT / "public" / "assets"
SOURCE.mkdir(parents=True, exist_ok=True)
PUBLIC.mkdir(parents=True, exist_ok=True)
styles_path = PUBLIC.parent / "styles.css"
styles = styles_path.read_text(encoding="utf-8") if styles_path.exists() else ""


def palette_token(name, fallback):
    """Use the interface's named six-digit colors, with standalone fallbacks."""
    match = re.search(r"--" + re.escape(name) + r"\s*:\s*#([0-9a-fA-F]{6})(?=[;\s}])", styles)
    return match.group(1) if match else fallback


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
    for block in list(datablocks):
        if block.users == 0:
            datablocks.remove(block)


def rgba(hex_color):
    values = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in values) + (1,)


def material(name, color, metallic=0, roughness=.4, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba(color)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba(color)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = rgba(color)
        bsdf.inputs["Emission Strength"].default_value = emission
    return mat


ceramic = material("Pearl ceramic hull", "e4e9ff", .25, .28)
periwinkle = material("Periwinkle anodized alloy", palette_token("accent", "aab8ff"), .5, .3)
navy = material("Midnight graphite", "141d36", .65, .28)
glass = material("Smoked blue cockpit", "224a6d", .7, .14)
cyan = material("Cyan running lights", palette_token("cyan", "68e4ef"), .25, .3, 2)
orbit_mat = material("Quiet periwinkle orbit", "566787", .35, .4, .35)
coral = material("Coral ceramic", palette_token("coral", "ffad9b"), .2, .45)
planet_mat = material("Indigo planet", "4d5894", .24, .4)
dark = material("Deep navy satellite", "172740", .25, .38)
star_mat = material("Distant points", "94a9d0", 0, .4, 1.3)


def sphere(name, location, radius, mat, scale=(1, 1, 1), parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    if parent:
        obj.parent = parent
    return obj


def line(name, points, mat, radius=.014, cyclic=False, parent=None):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for p, co in zip(spline.points, points):
        p.co = (*co, 1)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
    return obj


def orbit(name, center, radius, mat, tilt=(0, 0, 0), width=.015, squash=1):
    points = [(radius * math.cos(a * math.tau / 256), radius * math.sin(a * math.tau / 256) * squash, 0) for a in range(256)]
    obj = line(name, points, mat, width, cyclic=True)
    obj.location = center
    obj.rotation_euler = tilt
    return obj


def beveled_prism(name, polygon, bottom, top, mat, bevel=.12, parent=None):
    n = len(polygon)
    vertices = [(x, y, bottom) for x, y in polygon] + [(x, y, top) for x, y in polygon]
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    mod = obj.modifiers.new("Soft manufactured edges", "BEVEL")
    mod.width = bevel
    mod.segments = 4
    mod = obj.modifiers.new("Weighted surface normals", "WEIGHTED_NORMAL")
    if parent:
        obj.parent = parent
    return obj


# Planets deliberately have broad, quiet surfaces: the ship remains the focal point.
sphere("Repository planet", (4.35, 3.1, 1.5), 2.15, planet_mat)
for i, (z, radius) in enumerate([(-.35, 2.11), (.04, 2.15), (.43, 2.11)]):
    orbit(f"Planet latitude {i}", (4.35, 3.1, 1.5 + z), radius + .005, orbit_mat, width=.008)
orbit("Main orbital ellipse", (4.35, 3.1, 1.5), 3.06, periwinkle, tilt=(.2, -.17, 0), width=.025)
orbit("Fine orbital echo", (4.35, 3.1, 1.5), 3.31, orbit_mat, tilt=(.2, -.17, 0), width=.009)
sphere("Orbiting pearl", (1.46, 2.54, 2.21), .22, ceramic)
sphere("Warm southern world", (5.5, -.6, -2.38), 1.04, coral)
orbit("Southern world equator", (5.5, -.6, -2.38), 1.27, orbit_mat, tilt=(.3, .38, .15), width=.014)
sphere("Far moon", (1.5, 5, 3), .32, ceramic)

# A molecular folder cluster sits in the middle distance below the flight path.
nodes = [(-1.75, 2.1, -2.7), (-.8, 2.75, -2.4), (-.47, 1.6, -3.35), (-2.7, 3.2, -3.2)]
for i, j in [(0, 1), (1, 2), (0, 3)]:
    line(f"Folder connection {i}-{j}", [nodes[i], nodes[j]], orbit_mat, .033)
for i, position in enumerate(nodes):
    sphere(f"Folder satellite {i}", position, [.3, .4, .23, .2][i], periwinkle if i == 1 else dark)

# Custom mesh explorer: a ceramic arrow hull, split swept wings, and twin engines.
ship = bpy.data.objects.new("Space Drift explorer", None)
bpy.context.collection.objects.link(ship)
ship.location = (1.6, -2.6, .2)
ship.rotation_euler = (.12, -.13, -.55)
ship.scale = (1.13, 1.13, 1.13)
beveled_prism("Ceramic fuselage", [(-.53, -1.15), (.53, -1.15), (.64, -.45), (.4, .88), (0, 1.72), (-.4, .88), (-.64, -.45)], -.14, .24, ceramic, .15, ship)
beveled_prism("Graphite keel", [(-.46, -1.21), (.46, -1.21), (.51, -.25), (0, 1.56), (-.51, -.25)], -.3, -.05, navy, .1, ship)
for side in [-1, 1]:
    wing = [(side * .36, -.82), (side * 1.61, -1.18), (side * 1.32, -.19), (side * .32, .73)]
    if side == -1:
        wing.reverse()
    beveled_prism(f"Swept wing {side}", wing, -.1, .07, periwinkle, .095, ship)
    panel = [(side * .65, -.76), (side * 1.32, -.97), (side * 1.16, -.28), (side * .67, .12)]
    if side == -1:
        panel.reverse()
    beveled_prism(f"Wing graphite inset {side}", panel, .065, .085, navy, .035, ship)
    line(f"Wing light {side}", [(side * 1.29, -.93, .12), (side * 1.12, -.34, .12)], cyan, .018, parent=ship)
    sphere(f"Engine nacelle {side}", (side * .66, -.92, -.01), .32, navy, scale=(.77, 1.72, .77), parent=ship)
    sphere(f"Engine aperture {side}", (side * .66, -1.4, -.01), .21, cyan, scale=(.8, .22, .8), parent=ship)
    # Short, soft-looking engineered plumes, rather than noisy bloom.
    sphere(f"Ion plume {side}", (side * .66, -1.63, -.01), .13, cyan, scale=(.53, 1.52, .53), parent=ship)
beveled_prism("Cockpit surround", [(-.31, -.1), (.31, -.1), (.27, .65), (0, 1.14), (-.27, .65)], .24, .31, navy, .08, ship)
sphere("Smoked cockpit canopy", (0, .36, .31), .34, glass, scale=(.82, 1.7, .57), parent=ship)
beveled_prism("Aft ceramic spine", [(-.13, -1.09), (.13, -1.09), (.16, -.29), (-.16, -.29)], .24, .32, ceramic, .045, ship)
line("Nose signal", [(-.105, 1.16, .29), (0, 1.38, .29), (.105, 1.16, .29)], cyan, .018, parent=ship)
line("Aft coral identification stripe", [(-.22, -.75, .255), (-.22, -.4, .255)], coral, .025, parent=ship)

# A thin course arc leads the eye into the illustration while leaving the left quiet.
route = []
for i in range(100):
    t = i / 99
    route.append((-4.6 + 5.9 * t, 2.8 - 4.5 * t, -1.35 + .75 * math.sin(t * math.pi)))
line("Quiet course arc", route, orbit_mat, .009)
for i in [8, 33, 58]:
    sphere(f"Course waypoint {i}", route[i], .045, cyan)

# Sparse, reproducible distant stars. The left third is reserved for interface copy.
rng = random.Random(427)
for i in range(46):
    x = rng.uniform(-8.5, 9)
    z = rng.uniform(-6, 7)
    sphere(f"Distant star {i:02}", (x, 9, z), rng.uniform(.008, .019), star_mat)


def area_light(name, location, power, color, size, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = power
    data.color = rgba(color)[:3]
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


area_light("Large pearl key", (-3, -5, 10), 2200, "e3eaff", 8, (2, 0, 0))
area_light("Cyan rim", (9, 4, 6), 2700, "83dded", 7, (3, 1, 0))
area_light("Soft coral fill", (3, -5, -1), 650, "ffd4c4", 6, (2, 0, 0))

scene = bpy.context.scene
world = bpy.data.worlds.new("Midnight space")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = rgba("080b18")
world.node_tree.nodes["Background"].inputs["Strength"].default_value = .5
# Keep the photographed sky navy without washing out the sculptural lighting.
world_nodes = world.node_tree.nodes
camera_sky = world_nodes.new("ShaderNodeBackground")
camera_sky.name = "Navy camera backdrop"
camera_sky.inputs["Color"].default_value = rgba("181525")
camera_sky.inputs["Strength"].default_value = 1
light_path = world_nodes.new("ShaderNodeLightPath")
sky_mix = world_nodes.new("ShaderNodeMixShader")
world.node_tree.links.new(light_path.outputs["Is Camera Ray"], sky_mix.inputs[0])
world.node_tree.links.new(world_nodes["Background"].outputs[0], sky_mix.inputs[1])
world.node_tree.links.new(camera_sky.outputs[0], sky_mix.inputs[2])
world.node_tree.links.new(sky_mix.outputs[0], world_nodes["World Output"].inputs["Surface"])
scene.world = world
camera_data = bpy.data.cameras.new("Editorial orbital camera")
camera = bpy.data.objects.new("Editorial orbital camera", camera_data)
bpy.context.collection.objects.link(camera)
camera.location = (0, -22, 11)
target = Vector((.25, .2, .15))
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = 18.5
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "WEBP"
scene.render.image_settings.color_mode = "RGB"
scene.render.image_settings.quality = 92
scene.render.film_transparent = False
# Blender resolves this from assets/source/orbital-scene.blend after saving.
# Keep the checked-in source portable between different clones and machines.
scene.render.filepath = "//../../public/assets/orbital-scene.webp"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = .4
scene.render.use_file_extension = True
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "orbital-scene.blend"), compress=True)
bpy.ops.render.render(write_still=True)

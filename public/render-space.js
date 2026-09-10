import { createLightRenderer } from './render-light.js';
import { luminosity, emits, bodyColor, emissionColor, remainingExcitation, illumination } from './light.js';
import { L_MIN } from './constants.js';
import { colorOf, vector, instanceEmission, disposeGroup, circle, createFieldSheet, createStars, createLabels } from './render-common.js';

const variant = (id) => {
  let value = 2166136261;
  for (const character of String(id)) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return (value >>> 0) % 3;
};
const planetModels = ['planet_basalt', 'planet_ocean', 'planet_ice'];

export function createSpaceRenderer({ THREE, scene, assets }) {
  const group = new THREE.Group(); group.name = 'space-layer'; scene.add(group);
  const geometryGroup = new THREE.Group(); group.add(geometryGroup);
  const lighting = createLightRenderer({ THREE, group });
  const scratch = new THREE.Object3D();
  let world = null, sheet = null, labels = null, stars = null, visuals = [], suspended = false;

  function setWorld(next) {
    if (suspended) { world = next; lighting.setBodies(world.bodies || [], world.now); return; }
    const oldGrid = sheet?.grid;
    world = next; labels?.dispose(); disposeGroup(geometryGroup); visuals = [];
    sheet = createFieldSheet(THREE, world, { previous: oldGrid }); geometryGroup.add(sheet.group);
    const labelRows = [];
    for (const body of world.bodies || []) {
      const position = body.center || body.position, radius = body.radius || 12;
      const tint = colorOf(THREE, bodyColor(body));
      let mesh, surface;
      const materials = [];
      if (body.kind === 'belt' || body.kind === 'overflow') {
        const count = body.kind === 'belt' ? Math.max(1, Math.min(32, body.crystals?.length || 32)) : Math.min(18, Math.max(4, body.members?.length || 8));
        const geometry = assets.geometry('asteroid');
        surface = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: .76, metalness: .16, emissive: 0xffffff, emissiveIntensity: 1 });
        geometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
        instanceEmission(surface);
        mesh = new THREE.InstancedMesh(geometry, surface, count);
        for (let i = 0; i < count; i++) {
          const angle = i * 2.39996;
          const r = body.kind === 'belt' ? radius * (.6 + (i % 4) * .13) : radius * .58 * Math.sqrt((i + 1) / count);
          scratch.position.set(Math.cos(angle) * r, Math.sin(i * 3.7) * radius * .13, Math.sin(angle) * r);
          scratch.rotation.set(i * .6, i * .7, i * .2);
          scratch.scale.setScalar(radius * (body.kind === 'belt' ? .08 : .19));
          scratch.updateMatrix(); mesh.setMatrixAt(i, scratch.matrix);
          mesh.setColorAt(i, tint);
        }
        mesh.instanceMatrix.needsUpdate = true;
      } else {
        const modelName = planetModels[variant(body.id)];
        mesh = assets.instantiate(modelName);
        mesh.userData.modelAsset = modelName;
        mesh.scale.setScalar(radius);
        mesh.rotation.y = variant(body.id + ':orientation') * 2.1;
        mesh.traverse((node) => {
          if (!node.isMesh) return;
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            materials.push({ material, color: material.color.clone(), emission: material.emissive.clone(), intensity: material.emissiveIntensity });
          }
        });
      }
      mesh.position.copy(vector(THREE, position)); geometryGroup.add(mesh);

      // A folder's excitation appears as a small piece of matter embedded in the crust.
      const patchRows = body.kind === 'planet' ? (body.patches || []).slice(0, 16) : [];
      let patches = null;
      if (patchRows.length) {
        const geometry = assets.geometry('atom_data');
        geometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array(patchRows.length), 1));
        const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: .6, metalness: .22, emissive: 0xffffff, emissiveIntensity: 1 });
        instanceEmission(material);
        patches = new THREE.InstancedMesh(geometry, material, patchRows.length);
        patches.name = `surface-patches:${body.id}`;
        patches.position.copy(mesh.position);
        geometryGroup.add(patches);
        mesh.updateWorldMatrix(true, true);
        patches.updateWorldMatrix(true, false);
        const ray = new THREE.Raycaster(), direction = new THREE.Vector3();
        const center = mesh.getWorldPosition(new THREE.Vector3());
        patchRows.forEach((patch, i) => {
          const y = 1 - 2 * (i + .5) / patchRows.length, horizontal = Math.sqrt(1 - y * y), angle = i * 2.39996;
          const patchRadius = radius * (.025 + .025 * Math.sqrt(Math.max(0, patch.share || 0)));
          direction.set(Math.cos(angle) * horizontal, y, Math.sin(angle) * horizontal);
          ray.ray.origin.copy(center).addScaledVector(direction, radius * 1.2);
          ray.ray.direction.copy(direction).negate();
          // Sample the rotated authored crust once, rather than burying patches
          // under an assumed spherical surface or raycasting during animation.
          const hit = ray.intersectObject(mesh, true)[0];
          const point = hit ? hit.point.clone() : center.clone().addScaledVector(direction, radius);
          point.addScaledVector(direction, patchRadius * .18);
          scratch.position.copy(patches.worldToLocal(point));
          scratch.rotation.set(i * .8, angle, 0);
          scratch.scale.setScalar(patchRadius);
          scratch.updateMatrix(); patches.setMatrixAt(i, scratch.matrix);
          patches.setColorAt(i, patch.color ? colorOf(THREE, patch.color) : tint);
        });
      }
      const landing = circle(THREE, body.landingRadius || radius + 30, 0xaab8ff);
      landing.position.set(position.x, sheet.heightAt(position.x, position.z) + .25, position.z); geometryGroup.add(landing);
      const approach = circle(THREE, 2 * (body.landingRadius || radius + 30), 0x68e4ef);
      approach.position.copy(landing.position); approach.material.opacity = .05; geometryGroup.add(approach);
      const horizon = circle(THREE, Math.max(1, body.horizonRadius || 1), 0xffad9b, true);
      horizon.position.copy(landing.position); horizon.visible = body.horizonRadius > radius; geometryGroup.add(horizon);
      const flashRing = circle(THREE, radius, 0xe3eaff);
      flashRing.position.copy(landing.position); flashRing.visible = false; geometryGroup.add(flashRing);
      if (body.partial || body.survey?.partial || body.survey?.pending) {
        const partial = circle(THREE, radius * 1.15, body.survey?.pending ? 0x7888ac : 0xc4a5ff, true);
        partial.position.copy(mesh.position); partial.rotation.x = .3; geometryGroup.add(partial);
      }
      labelRows.push({ text: `${body.name || body.id}${body.constellation ? ` · ${body.constellation}` : ''}${body.git?.branch ? ` / ${body.git.branch}` : ''}${body.survey?.pending ? ' · surveying' : ''}`, position: { x: position.x, y: position.y + radius + 10, z: position.z } });
      visuals.push({ body, mesh, surface, materials, patches, patchRows, landing, approach, horizon, flashRing, landingBase: body.landingRadius || radius + 30, horizonBase: Math.max(1, body.horizonRadius || 1) });
    }
    const constellations = new Map();
    for (const body of world.bodies || []) if (body.constellation) {
      if (!constellations.has(body.constellation)) constellations.set(body.constellation, []);
      constellations.get(body.constellation).push(body);
    }
    for (const [name, bodies] of constellations) {
      const center = bodies.reduce((p, body) => ({ x: p.x + body.center.x / bodies.length, y: 0, z: p.z + body.center.z / bodies.length }), { x: 0, y: 0, z: 0 });
      const radius = Math.max(...bodies.map((body) => Math.hypot(body.center.x - center.x, body.center.z - center.z) + (body.radius || 12))) + 22;
      const ring = circle(THREE, radius, 0x6e719e, true, 140);
      ring.position.set(center.x, -2, center.z); ring.material.opacity = .12; geometryGroup.add(ring);
      labelRows.push({ text: name.toUpperCase(), position: { x: center.x, y: 25, z: center.z - radius } });
    }
    stars = createStars(THREE, (world.bodies || []).map((body) => ({ position: body.center, color: bodyColor(body), size: 3 + Math.log2(1 + luminosity(body) / L_MIN) })));
    geometryGroup.add(stars);
    labels = createLabels(THREE, labelRows, 'space'); lighting.setBodies(world.bodies || [], world.now);
  }

  function update({ world: next = world, now = Date.now(), dt = 0, ship, camera, overlay = 'off', fieldEnabled = true } = {}) {
    if (!world) return { emitters: [], illumination: [], flashes: [], cooling: [], pointLights: 0 };
    if (next !== world) setWorld(next);
    sheet.update(dt, overlay); sheet.group.visible = fieldEnabled || overlay !== 'off';
    const telemetry = lighting.update({ now, ship, bodies: world.bodies });
    visuals.forEach((visual, i) => {
      const { body } = visual, active = emits(body, now), light = luminosity(body, now), flash = lighting.flash(body.id, now);
      const tint = colorOf(THREE, bodyColor(body, [], now));
      for (const { material, color, emission, intensity } of visual.materials) {
        material.color.copy(color).multiplyScalar(body.survey?.pending ? .35 : 1);
        material.emissive.copy(emission).lerp(tint, active ? .35 : 0);
        material.emissiveIntensity = intensity + (active ? Math.min(.14, Math.log2(1 + light / L_MIN) * .018) : 0) + flash * .3;
      }
      if (visual.mesh.isInstancedMesh) {
        for (let j = 0; j < visual.mesh.count; j++) {
          const atom = body.crystals?.[j], emitting = atom && emits(atom, now);
          visual.mesh.setColorAt(j, colorOf(THREE, atom ? emissionColor(atom, now) : [.46, .55, .76]));
          visual.mesh.geometry.attributes.emission.setX(j, (emitting ? .05 + Math.min(.2, Math.log2(1 + luminosity(atom, now) / L_MIN) * .022) : 0) + flash * .25);
        }
        visual.mesh.instanceColor.needsUpdate = true; visual.mesh.geometry.attributes.emission.needsUpdate = true;
      }
      visual.approach.material.opacity = ship ? .025 + .15 * Math.max(0, 1 - Math.hypot(ship.position.x - body.center.x, ship.position.y - body.center.y, ship.position.z - body.center.z) / Math.max(1, 3 * body.landingRadius)) : .025;
      visual.landing.material.opacity = .22 + flash * .45;
      visual.flashRing.visible = flash > 0; visual.flashRing.material.opacity = flash * .5;
      const flashScale = 1 + (1 - flash) * Math.max(1, body.landingRadius * 2 / body.radius - 1);
      visual.flashRing.scale.set(flashScale, 1, flashScale);
      visual.landing.scale.setScalar(body.landingRadius / visual.landingBase);
      visual.approach.scale.copy(visual.landing.scale);
      visual.horizon.scale.setScalar(body.horizonRadius / visual.horizonBase); visual.horizon.visible = body.horizonRadius > body.radius;
      for (const ring of [visual.landing, visual.approach, visual.horizon, ...(flash ? [visual.flashRing] : [])]) {
        ring.position.y = 0;
        const attribute = ring.geometry.attributes.position;
        for (let j = 0; j < attribute.count; j++) attribute.setY(j, (sheet.heightAt(body.center.x + attribute.getX(j) * ring.scale.x, body.center.z + attribute.getZ(j) * ring.scale.z) + .3) / Math.max(.001, ring.scale.y));
        attribute.needsUpdate = true;
      }
      if (visual.patches) {
        const decay = remainingExcitation(body, now) / Math.max(1, body.excitation || 0);
        visual.patchRows.forEach((patch, j) => visual.patches.geometry.attributes.emission.setX(j, Math.min(.3, Math.max(0, patch.xi || 0) * decay * .2) + flash * .25));
        visual.patches.geometry.attributes.emission.needsUpdate = true;
      }
      stars.geometry.attributes.size.setX(i, active ? 2 + Math.log2(1 + light / L_MIN) : 0);
      const brightness = .2 + (body.illumination ?? illumination(body, world.bodies, now)) * .6;
      stars.geometry.attributes.color.setXYZ(i, tint.r * brightness, tint.g * brightness, tint.b * brightness);
    });
    stars.geometry.attributes.size.needsUpdate = true; stars.geometry.attributes.color.needsUpdate = true;
    if (camera) labels.update(camera, group.visible);
    return { ...telemetry, overlayRange: sheet.range, drawables: geometryGroup.children.length };
  }
  function suspend() { if (suspended) return; suspended = true; labels?.dispose(); labels = null; disposeGroup(geometryGroup); sheet = null; stars = null; visuals = []; }
  function reset() { suspend(); world = null; lighting.reset(); group.visible = false; }
  return { group, setWorld, update, suspend, reset, setVisible(value) { group.visible = value; if (!value) suspend(); else if (suspended && world) { suspended = false; setWorld(world); } }, dispose() { labels?.dispose(); disposeGroup(group); scene.remove(group); world = null; } };
}

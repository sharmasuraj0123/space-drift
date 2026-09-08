import { createLightRenderer } from './render-light.js';
import { luminosity, emits, bodyColor, emissionColor, remainingExcitation, illumination } from './light.js';
import { L_MIN } from './constants.js';
import { colorOf, vector, instanceEmission, disposeGroup, circle, createFieldSheet, createStars, createLabels } from './render-common.js';

export function createSpaceRenderer({ THREE, scene }) {
  const group = new THREE.Group(); group.name = 'space-layer'; scene.add(group);
  const geometryGroup = new THREE.Group(); group.add(geometryGroup);
  const lighting = createLightRenderer({ THREE, group });
  const scratch = new THREE.Object3D();
  let world = null, sheet = null, labels = null, stars = null, visuals = [], constellationRings = [], suspended = false;
  function setWorld(next) {
    if (suspended) { world = next; lighting.setBodies(world.bodies || [], world.now); return; }
    const oldGrid = sheet?.grid; world = next; labels?.dispose(); disposeGroup(geometryGroup); visuals = []; constellationRings = [];
    sheet = createFieldSheet(THREE, world, { previous: oldGrid }); geometryGroup.add(sheet.group);
    const labelRows = [], sphereGeometry = new THREE.SphereGeometry(1, 28, 18), crystalGeometry = new THREE.OctahedronGeometry(1, 0);
    for (const body of world.bodies || []) {
      const position = body.center || body.position, radius = body.radius || 12, tint = colorOf(THREE, bodyColor(body));
      const surface = new THREE.MeshStandardMaterial({ color: tint.clone().multiplyScalar(.38), emissive: tint, emissiveIntensity: 0, roughness: .88, metalness: .12 });
      let mesh;
      if (body.kind === 'belt' || body.kind === 'overflow') {
        const count = body.kind === 'belt' ? Math.max(1, Math.min(32, body.crystals?.length || 32)) : Math.min(18, Math.max(4, body.members?.length || 8));
        if (body.kind === 'belt') { crystalGeometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array(count), 1)); instanceEmission(surface); }
        mesh = new THREE.InstancedMesh(body.kind === 'belt' ? crystalGeometry : sphereGeometry, surface, count);
        for (let i = 0; i < count; i++) { const angle = i * 2.39996, r = body.kind === 'belt' ? radius * (.6 + (i % 4) * .13) : radius * .58 * Math.sqrt((i + 1) / count); scratch.position.set(Math.cos(angle) * r, Math.sin(i * 3.7) * radius * .13, Math.sin(angle) * r); scratch.rotation.set(i * .6, i * .7, i * .2); scratch.scale.setScalar(radius * (body.kind === 'belt' ? .08 : .19)); scratch.updateMatrix(); mesh.setMatrixAt(i, scratch.matrix); }
        mesh.instanceMatrix.needsUpdate = true;
      } else { mesh = new THREE.Mesh(sphereGeometry, surface); mesh.scale.setScalar(radius); }
      mesh.position.copy(vector(THREE, position)); geometryGroup.add(mesh);
      const patches = [];
      for (const [i, patch] of (body.patches || []).slice(0, 16).entries()) {
        const span = Math.min(2.5, .2 + Math.sqrt(Math.max(0, patch.share || 0)) * 2.5), theta = .25 + ((i * .61) % 1.8);
        const patchTint = patch.color ? colorOf(THREE, patch.color) : tint;
        const material = new THREE.MeshStandardMaterial({ color: patchTint, emissive: patchTint, emissiveIntensity: .02 + (patch.xi || 0) * 2.5, transparent: true, opacity: .62, roughness: .65, depthWrite: false });
        const patchMesh = new THREE.Mesh(new THREE.SphereGeometry(radius + .05, 12, 8, i * 2.39996, span, theta, Math.min(.7, Math.PI - theta)), material); patchMesh.position.copy(mesh.position); geometryGroup.add(patchMesh); patches.push({ mesh: patchMesh, patch });
      }
      const landing = circle(THREE, body.landingRadius || radius + 30, 0xaab8ff); landing.position.copy(mesh.position); landing.position.y = sheet.heightAt(position.x, position.z) + .25; geometryGroup.add(landing);
      const approach = circle(THREE, 2 * (body.landingRadius || radius + 30), 0x68e4ef); approach.position.copy(landing.position); approach.material.opacity = .1; geometryGroup.add(approach);
      const horizon = circle(THREE, Math.max(1, body.horizonRadius || 1), 0xffad9b, true); horizon.position.copy(landing.position); horizon.visible = body.horizonRadius > radius; geometryGroup.add(horizon);
      const flashRing = circle(THREE, radius, 0xe3eaff); flashRing.position.copy(landing.position); flashRing.visible = false; geometryGroup.add(flashRing);
      if (body.partial || body.survey?.partial || body.survey?.pending) { const partial = circle(THREE, radius * 1.15, body.survey?.pending ? 0x7888ac : 0xc4a5ff, true); partial.position.copy(mesh.position); partial.rotation.x = .3; geometryGroup.add(partial); }
      labelRows.push({ text: `${body.name || body.id}${body.constellation ? ` · ${body.constellation}` : ''}${body.git?.branch ? ` / ${body.git.branch}` : ''}${body.survey?.pending ? ' · surveying' : ''}`, position: { x: position.x, y: position.y + radius + 10, z: position.z } });
      visuals.push({ body, mesh, surface, patches, landing, approach, horizon, flashRing, landingBase: body.landingRadius || radius + 30, horizonBase: Math.max(1, body.horizonRadius || 1) });
    }
    const groups = new Map();
    for (const body of world.bodies || []) if (body.constellation) { if (!groups.has(body.constellation)) groups.set(body.constellation, []); groups.get(body.constellation).push(body); }
    for (const [name, bodies] of groups) {
      const center = bodies.reduce((p, body) => ({ x: p.x + body.center.x / bodies.length, y: 0, z: p.z + body.center.z / bodies.length }), { x: 0, y: 0, z: 0 });
      const radius = Math.max(...bodies.map((body) => Math.hypot(body.center.x - center.x, body.center.z - center.z) + (body.radius || 12))) + 22;
      const ring = circle(THREE, radius, 0x6e719e, true, 140); ring.position.set(center.x, -2, center.z); ring.material.opacity = .16; geometryGroup.add(ring); constellationRings.push(ring); labelRows.push({ text: name.toUpperCase(), position: { x: center.x, y: 25, z: center.z - radius } });
    }
    stars = createStars(THREE, (world.bodies || []).map((body) => ({ position: body.center, color: bodyColor(body), size: 4 + Math.log2(1 + luminosity(body) / L_MIN) * 2 }))); geometryGroup.add(stars);
    labels = createLabels(THREE, labelRows, 'space'); lighting.setBodies(world.bodies || [], world.now);
  }
  function update({ world: next = world, now = Date.now(), dt = 0, ship, camera, overlay = 'off', fieldEnabled = true } = {}) {
    if (!world) return { emitters: [], illumination: [], flashes: [], cooling: [], pointLights: 0 };
    if (next !== world) setWorld(next);
    sheet.update(dt, overlay); sheet.group.visible = fieldEnabled || overlay !== 'off';
    const telemetry = lighting.update({ now, ship, bodies: world.bodies });
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i], { body } = visual, active = emits(body, now), light = luminosity(body, now), flash = lighting.flash(body.id, now);
      const tint = colorOf(THREE, bodyColor(body, [], now)); visual.surface.color.copy(tint).multiplyScalar(body.survey?.pending ? .14 : .3 + (body.illumination ?? illumination(body, world.bodies, now)) * .45); visual.surface.emissive.copy(tint); visual.surface.emissiveIntensity = (active ? .1 + Math.min(1.6, Math.log2(1 + light / L_MIN) * .2) : 0) + Math.sin(Math.max(0, flash) * Math.PI) * .7;
      if (body.kind === 'belt') {
        visual.surface.color.setRGB(.4, .4, .4); visual.surface.emissive.setRGB(1, 1, 1); visual.surface.emissiveIntensity = 1;
        for (let j = 0; j < visual.mesh.count; j++) { const atom = body.crystals?.[j], emitting = atom && emits(atom, now); visual.mesh.setColorAt(j, colorOf(THREE, atom ? emissionColor(atom, now) : [ .36, .43, .62 ])); visual.mesh.geometry.attributes.emission.setX(j, (emitting ? .6 + Math.min(1, Math.log2(1 + luminosity(atom, now) / L_MIN) * .18) : 0) + flash * .4); }
        visual.mesh.instanceColor.needsUpdate = true; visual.mesh.geometry.attributes.emission.needsUpdate = true;
      }
      visual.approach.material.opacity = ship ? .06 + .34 * Math.max(0, 1 - Math.hypot(ship.position.x - body.center.x, ship.position.y - body.center.y, ship.position.z - body.center.z) / Math.max(1, 3 * body.landingRadius)) : .06;
      visual.landing.material.opacity = .36 + flash * .45;
      visual.mesh.scale.setScalar((visual.mesh.isInstancedMesh ? 1 : body.radius) * (1 + Math.sin(flash * Math.PI) * .025));
      visual.flashRing.visible = flash > 0; visual.flashRing.material.opacity = flash * .65;
      const flashScale = 1 + (1 - flash) * Math.max(1, body.landingRadius * 2 / body.radius - 1); visual.flashRing.scale.set(flashScale, 1, flashScale);
      const ratio = body.landingRadius / visual.landingBase; visual.landing.scale.set(ratio, 1, ratio); visual.approach.scale.set(ratio, 1, ratio); visual.horizon.scale.set(body.horizonRadius / visual.horizonBase, 1, body.horizonRadius / visual.horizonBase); visual.horizon.visible = body.horizonRadius > body.radius;
      for (const ring of [visual.landing, visual.approach, visual.horizon, ...(flash ? [visual.flashRing] : [])]) {
        ring.position.y = 0; const attribute = ring.geometry.attributes.position;
        for (let j = 0; j < attribute.count; j++) attribute.setY(j, sheet.heightAt(body.center.x + attribute.getX(j) * ring.scale.x, body.center.z + attribute.getZ(j) * ring.scale.z) + .3);
        attribute.needsUpdate = true;
      }
      const decay = remainingExcitation(body, now) / Math.max(1, body.excitation || 0);
      for (const { mesh, patch } of visual.patches) mesh.material.emissiveIntensity = Math.max(0, patch.xi || 0) * decay * 2 + flash * .6;
      stars.geometry.attributes.size.setX(i, 4 + Math.log2(1 + light / L_MIN) * 2);
      const brightness = .3 + (body.illumination ?? illumination(body, world.bodies, now)) * .7; stars.geometry.attributes.color.setXYZ(i, tint.r * brightness, tint.g * brightness, tint.b * brightness);
    }
    stars.geometry.attributes.size.needsUpdate = true; stars.geometry.attributes.color.needsUpdate = true; if (camera) labels.update(camera, group.visible);
    return { ...telemetry, overlayRange: sheet.range, drawables: geometryGroup.children.length };
  }
  function suspend() { if (suspended) return; suspended = true; labels?.dispose(); labels = null; disposeGroup(geometryGroup); sheet = null; stars = null; visuals = []; constellationRings = []; }
  function reset() { suspend(); world = null; lighting.reset(); group.visible = false; }
  return { group, setWorld, update, suspend, reset, setVisible(value) { group.visible = value; if (!value) suspend(); else if (suspended && world) { suspended = false; setWorld(world); } }, dispose() { labels?.dispose(); disposeGroup(group); scene.remove(group); world = null; } };
}

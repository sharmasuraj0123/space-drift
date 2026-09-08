import { AMBIENT, HEADLAMP_RANGE, FLASH_SECONDS, L_MIN } from './constants.js';
import { luminosity, emits, illumination, bodyColor, remainingExcitation, flashesFrom, coolingFrom } from './light.js';
import { vector, colorOf } from './render-common.js';

export function createLightRenderer({ THREE, group, excludeRoot = false }) {
  const lights = new THREE.Group(); group.add(lights);
  const ambient = new THREE.AmbientLight(0xc7d2ff, AMBIENT); lights.add(ambient);
  const points = Array.from({ length: 8 }, () => { const light = new THREE.PointLight(0xffffff, 0, 500, 2); lights.add(light); return light; });
  const lamp = new THREE.SpotLight(0xe2edff, 12, HEADLAMP_RANGE, Math.PI / 4, .8, 1); const target = new THREE.Object3D(); lights.add(lamp, target); lamp.target = target;
  let previous = new Map(), flashRecords = [], coolingRecords = [], current = [], initialized = false;
  function setBodies(bodies, now = Date.now(), flashBodies = bodies) {
    current = bodies.filter((body) => !excludeRoot || body.id !== '.'); const next = new Map(flashBodies.map((body) => [body.id, { ...body }]));
    if (initialized) {
      const changes = flashBodies.filter((body) => previous.has(body.id) ? !previous.get(body.id).survey?.pending : excludeRoot).map((body) => ({ id: body.id, excitation: remainingExcitation(body, now), previousExcitation: remainingExcitation(previous.get(body.id), now), at: now, position: body.center || body.position }));
      flashRecords.push(...flashesFrom(changes, new Map(), now));
      coolingRecords.push(...coolingFrom([...previous.values()].filter((body) => !next.has(body.id)).map((body) => ({ type: 'deleted', id: body.id, at: now, position: body.center || body.position })), now));
    }
    previous = next; initialized = true;
  }
  function update({ now = Date.now(), ship, bodies = current } = {}) {
    const eligible = bodies.filter((b) => !excludeRoot || b.id !== '.'); const ranked = eligible.filter((b) => emits(b, now)).sort((a, b) => luminosity(b, now) - luminosity(a, now) || String(a.id).localeCompare(String(b.id)));
    points.forEach((point, i) => {
      const body = ranked[i]; point.visible = !!body;
      if (!body) return;
      point.position.copy(vector(THREE, body.center || body.position)); point.position.y += Math.max(3, body.radius || body.clusterRadius || 3) * .45;
      point.color.copy(colorOf(THREE, bodyColor(body, [], now))); point.intensity = Math.min(80, 3 + Math.log2(1 + luminosity(body, now) / L_MIN) * 4); point.distance = Math.max(70, (body.radius || body.clusterRadius || 20) * 7);
    });
    if (ship) { lamp.position.copy(vector(THREE, ship.position)); lamp.position.y += 1; target.position.set(lamp.position.x - Math.sin(ship.yaw || 0) * HEADLAMP_RANGE, lamp.position.y - 3, lamp.position.z - Math.cos(ship.yaw || 0) * HEADLAMP_RANGE); }
    flashRecords = flashRecords.filter((record) => record.until > now); coolingRecords = coolingRecords.filter((record) => record.until > now);
    return { emitters: ranked.map((b) => ({ id: b.id, luminosity: luminosity(b, now) })), illumination: eligible.map((b) => ({ id: b.id, value: Number.isFinite(b.illumination) ? b.illumination : illumination(b, eligible, now) })), flashes: flashRecords.map((r) => ({ ...r, progress: (now - r.at) / (FLASH_SECONDS * 1000) })), cooling: coolingRecords.map((r) => ({ ...r, progress: (now - r.at) / (FLASH_SECONDS * 1000) })), pointLights: Math.min(8, ranked.length) };
  }
  function reset() { previous = new Map(); flashRecords = []; coolingRecords = []; current = []; initialized = false; }
  return { group: lights, setBodies, update, reset, flash: (id, now) => flashRecords.filter((r) => r.id === id).reduce((v, r) => Math.max(v, 1 - (now - r.at) / (FLASH_SECONDS * 1000)), 0) };
}

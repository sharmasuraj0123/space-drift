export const PROBE_RANGE = 160;
export const PROBE_COOLDOWN = .65;
const magnitude = (p) => Math.hypot(p.x, p.y, p.z);
const distance = (a, b) => magnitude({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Camera-ray cone selection independent of rendering. Range is measured from the ship. */
export function selectTarget(objects, origin, ray, shipPosition = origin, { range = Infinity, tolerance = .045 } = {}) {
  const length = magnitude(ray);
  if (!length) return null;
  const direction = { x: ray.x / length, y: ray.y / length, z: ray.z / length };
  const candidates = [];
  for (const object of objects || []) {
    if (object.survey?.pending) continue;
    const p = object.position || object.center;
    if (!p) continue;
    const delta = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
    const depth = delta.x * direction.x + delta.y * direction.y + delta.z * direction.z;
    if (depth <= 0) continue;
    const perpendicular = Math.sqrt(Math.max(0, magnitude(delta) ** 2 - depth ** 2));
    const cone = Math.max(object.radius || 1, depth * tolerance);
    const d = distance(shipPosition, p);
    if (perpendicular <= cone && d <= range) candidates.push({ id: object.id, distance: d, depth, angularError: perpendicular / depth, object });
  }
  candidates.sort((a, b) => a.depth - b.depth || a.angularError - b.angularError || a.id.localeCompare(b.id));
  return candidates[0] || null;
}

export function createProbe(ship, target, now, lastFired = -Infinity, range = PROBE_RANGE) {
  if (!target) return { error: 'No target under the reticle.' };
  if (now - lastFired < PROBE_COOLDOWN) return { error: 'Probe recharging.' };
  const endpoint = target.object?.position || target.object?.center || target.position;
  if (!endpoint) return { error: 'That target is no longer mapped.' };
  const d = distance(ship.position, endpoint);
  if (d > range) return { error: 'Target out of probe range.' };
  return { probe: { id: target.id, start: { ...ship.position }, end: { ...endpoint }, position: { ...ship.position }, started: now, duration: .3 + .5 * Math.min(1, d / range), distance: d, progress: 0 } };
}

export function stepProbe(probe, now) {
  if (!probe) return null;
  const progress = Math.max(0, Math.min(1, (now - probe.started) / probe.duration));
  return { ...probe, progress, position: Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, probe.start[axis] + (probe.end[axis] - probe.start[axis]) * progress])), arrived: progress >= 1 };
}

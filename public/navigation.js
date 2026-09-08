import * as C from './constants.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = (n) => Number.isFinite(n) ? n : 0;
const point = (p = {}) => ({ x: finite(p.x), y: finite(p.y), z: finite(p.z) });
const length = (p) => Math.hypot(p.x, p.y, p.z);
const difference = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Segment/ellipsoid clearance includes the ship and a steering margin. */
export function segmentIntersectsCollider(from, to, collider, margin = 4) {
  const center = collider.center ?? collider.position;
  if (!center || !(collider.radius > 0)) return false;
  const r = collider.radius + C.SHIP_RADIUS + margin;
  const ry = collider.radius * (collider.kind === 'sphere' ? 1 : collider.scaleY ?? 1.5) + C.SHIP_RADIUS + margin;
  const a = { x: (from.x - center.x) / r, y: (from.y - center.y) / ry, z: (from.z - center.z) / r };
  const delta = { x: (to.x - from.x) / r, y: (to.y - from.y) / ry, z: (to.z - from.z) / r };
  const squared = delta.x ** 2 + delta.y ** 2 + delta.z ** 2;
  const t = squared ? clamp(-(a.x * delta.x + a.y * delta.y + a.z * delta.z) / squared, 0, 1) : 0;
  return Math.hypot(a.x + delta.x * t, a.y + delta.y * t, a.z + delta.z * t) < 1;
}

/** Clearance is recomputed from the current map; refreshes cannot stale a waypoint. */
export function clearanceWaypoint(ship, target, world) {
  const from = point(ship.position), to = point(target.position);
  const space = world.layer === 'space' || world.field?.kind === 'astro';
  const margin = space ? 14 : 4;
  const blockers = (world.colliders ?? []).filter((collider) => collider.id !== target.id && segmentIntersectsCollider(from, to, collider, margin));
  if (!blockers.length) return null;
  let altitude = Math.max(from.y, to.y, (world.floor ?? 0) + 12);
  for (const collider of blockers) {
    const p = collider.center ?? collider.position;
    const height = collider.radius * (collider.kind === 'sphere' ? 1 : collider.scaleY ?? 1.5);
    // Staying above twice a space body's radius also leaves enough lift authority
    // against its strongest gravity; atoms only need a small overhead corridor.
    altitude = Math.max(altitude, p.y + (space ? 2 * height + 24 : height + C.SHIP_RADIUS + 8));
  }
  return from.y < altitude - 2 ? { x: from.x, y: altitude, z: from.z } : { x: to.x, y: altitude, z: to.z };
}

/** Pure guidance: returns controls consumed by stepShip, never moves the ship. */
export function guideShip(ship, target, world, { fieldEnabled = true } = {}) {
  if (!target?.position) return { hold: true, waypoint: null };
  const from = point(ship.position), destination = point(target.position);
  const stop = Math.max(0, finite(target.stopDistance));
  if (length(difference(destination, from)) < stop) return { hold: true, waypoint: null };
  const waypoint = clearanceWaypoint(ship, target, world);
  const delta = difference(waypoint ?? destination, from), d = length(delta);
  if (d < 1e-9) return { hold: true, waypoint };
  const localStop = waypoint ? 0 : stop;
  const cruise = d > 150 ? 100 : Math.min(40, Math.max(5, (d - localStop) * 1.1));
  const desired = { x: delta.x / d * cruise, y: delta.y / d * cruise, z: delta.z / d * cruise };
  const field = fieldEnabled ? world.field : null;
  const conservative = point(field?.acceleration?.(from)), buffet = point(field?.buffet?.(from, ship.simulationTime ?? 0));
  const damping = Math.max(.01, field?.damping?.(from) ?? C.DAMPING_FREE);
  const velocity = point(ship.velocity);
  const force = Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, (desired[axis] - velocity[axis]) * 3.5 + desired[axis] * damping - conservative[axis] - buffet[axis]]));
  const horizontal = Math.hypot(force.x, force.z);
  const desiredYaw = horizontal > 1e-8 ? Math.atan2(-force.x, -force.z) : ship.yaw;
  const angle = Math.atan2(Math.sin(desiredYaw - ship.yaw), Math.cos(desiredYaw - ship.yaw));
  const boost = horizontal > C.THRUST_CRUISE || Math.abs(force.y) > C.THRUST_CRUISE * .7;
  const drive = boost ? C.THRUST_BOOST : C.THRUST_CRUISE;
  return { turn: clamp(angle * 2.5, -1, 1), thrust: Math.abs(angle) > 1 ? 0 : clamp(horizontal / drive, 0, 1), lift: clamp(force.y / (drive * .7), -1, 1), boost, waypoint };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { guideShip, clearanceWaypoint, segmentIntersectsCollider } from '../public/navigation.js';
import { stepShip } from '../public/model.js';
import { buildSpaceWorld, buildPlanetWorld } from '../public/bodies.js';
import { OPEN_RANGE } from '../public/constants.js';
const position = (x = 0, y = 0, z = 0) => ({ x, y, z });
const newShip = (p) => ({ position: { ...p }, velocity: position(), yaw: 0, simulationTime: 0 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function fly(ship, target, world, seconds = 60, fieldEnabled = true) {
  let usedClearance = false, minClearance = Infinity;
  for (let tick = 0; tick < seconds * 60; tick++) {
    if (distance(ship.position, target.position) < target.stopDistance) return { arrived: true, seconds: tick / 60, usedClearance, minClearance };
    const input = guideShip(ship, target, world, { fieldEnabled }); usedClearance ||= !!input.waypoint;
    stepShip(ship, input, world, 1 / 60, { field: fieldEnabled });
    for (const c of world.colliders ?? []) if (c.kind === 'sphere') minClearance = Math.min(minClearance, distance(ship.position, c.center) - c.radius);
  }
  return { arrived: false, usedClearance, minClearance, remaining: distance(ship.position, target.position) };
}

test('segment clearance respects ellipse tips, target exclusion and pure inputs', () => {
  const collider = { id: 'atom', kind: 'ellipsoid', radius: 2, scaleY: 1.5, center: position(0, 4, 0) };
  assert.equal(segmentIntersectsCollider(position(0, 6, 20), position(0, 6, -20), collider), true);
  assert.equal(segmentIntersectsCollider(position(0, 20, 20), position(0, 20, -20), collider), false);
  const ship = newShip(position(0, 6, 20)), target = { id: 'atom', position: position(0, 6, -20), stopDistance: 10 };
  const world = { layer: 'planet', floor: 2, colliders: [collider] }, before = JSON.stringify([ship, target, world]);
  assert.equal(clearanceWaypoint(ship, target, world), null);
  guideShip(ship, target, world);
  assert.equal(JSON.stringify([ship, target, world]), before);
});

test('guidance clears the exact collinear sphere that previously stalled a route', () => {
  const collider = { id: 'belt', kind: 'sphere', center: position(), radius: 50 };
  const world = { layer: 'space', colliders: [collider] }, ship = newShip(position(0, 0, 150));
  const target = { id: 'destination', kind: 'body', position: position(0, 0, -150), stopDistance: 4 };
  const result = fly(ship, target, world);
  assert.equal(result.arrived, true, JSON.stringify(result));
  assert.equal(result.usedClearance, true);
  assert(result.minClearance >= 1.4);
});

test('field-aware guidance reaches the heaviest and lightest body without teleporting', () => {
  const world = buildSpaceWorld({ bodies: [{ id: 'heavy', restMass: 200 * 1024 ** 2 }, { id: 'light', restMass: 1024 }] }, 0);
  for (const body of world.bodies) {
    const ship = newShip(world.launch), delta = { x: ship.position.x - body.center.x, y: ship.position.y - body.center.y, z: ship.position.z - body.center.z };
    const d = Math.hypot(delta.x, delta.y, delta.z), radius = .9 * body.landingRadius;
    const target = { id: body.id, kind: 'body', stopDistance: 4, position: Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, body.center[axis] + delta[axis] / d * radius])) };
    const result = fly(ship, target, world);
    assert.equal(result.arrived, true, `${body.id}: ${JSON.stringify(result)}`);
    assert(result.seconds > 1 && result.seconds < 40);
  }
});

test('hot 2500-atom surface route clears crystals and arrives within opening distance', () => {
  const now = 1000;
  const atoms = Array.from({ length: 2500 }, (_, i) => ({ id: `src/file-${String(i).padStart(4, '0')}.js`, path: `src/file-${String(i).padStart(4, '0')}.js`, atomicMass: 8000 + i, excitation: 8000 + i, excitationAt: now, element: 'source' }));
  const mass = atoms.reduce((n, a) => n + a.atomicMass, 0);
  const space = buildSpaceWorld({ bodies: [{ id: '.', restMass: mass, excitation: mass, excitationAt: now }] }, now);
  const world = buildPlanetWorld({ id: '.', atoms }, space, now);
  const start = world.atoms[0], end = world.atoms.at(-1);
  const ship = newShip({ x: start.position.x, y: 20, z: start.position.z });
  const target = { id: end.id, kind: 'atom', position: { ...end.position, y: Math.max(6, end.position.y + 2) }, stopDistance: 10 };
  const result = fly(ship, target, world, 120);
  assert.equal(result.arrived, true, JSON.stringify(result));
  assert(distance(ship.position, end.position) < OPEN_RANGE);
  assert(ship.position.y >= world.floor + 1.4);
});

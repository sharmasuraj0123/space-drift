import test from 'node:test';
import assert from 'node:assert/strict';
import { stepShip } from '../public/model.js';
import { gravityField, chemistryField, deriveSystemConstants } from '../public/field.js';
import * as C from '../public/constants.js';
const shipAt = (x = 0, y = 12, z = 0) => ({ position: { x, y, z }, velocity: { x: 0, y: 0, z: 0 }, yaw: -Math.PI / 2 });
const heavy = { id: 'body', restMass: 200 * 1024 ** 2, effMass: 200 * 1024 ** 2, radius: 54, center: { x: 0, y: 0, z: 0 } };
const field = gravityField([heavy], deriveSystemConstants([heavy]));
function fly(ship, input, world, seconds = 1, fps = 60, options) { for (let i = 0; i < seconds * fps; i++) stepShip(ship, input, world, 1 / fps, options); return ship; }
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('named cruise and boost drive strengths match the finite-tick response from rest', () => {
  assert.equal(C.THRUST_CRUISE, 81); assert.equal(C.THRUST_BOOST, 216);
  for (const boost of [false, true]) {
    const ship = shipAt(); stepShip(ship, { thrust: 1, boost }, {}, C.PHYSICS_STEP, { field: false });
    const inferredDrive = ship.velocity.x * C.DAMPING_FREE / (1 - Math.exp(-C.DAMPING_FREE * C.PHYSICS_STEP));
    assert(Math.abs(inferredDrive - (boost ? 216 : 81)) < 1e-9);
  }
});
test('near bodies fall, distant ships drift, and surface cruise loses while boost escapes', () => {
  const near = fly(shipAt(108, 0), {}, { field }, 1);
  const far = shipAt(1e7, 0); far.velocity.z = 10; fly(far, {}, { field }, 1);
  assert(near.position.x < 100); assert(Math.abs(far.position.x - 1e7) < .001); assert(far.position.z > 1);
  const cruise = fly(shipAt(54, 0), { thrust: 1 }, { field }, 1);
  const boost = fly(shipAt(54, 0), { thrust: 1, boost: true }, { field }, 1);
  const outer = fly(shipAt(108, 0), { thrust: 1 }, { field }, 1);
  assert(cruise.position.x < 54); assert(boost.position.x > 54); assert(outer.position.x > 108);
});
test('hold counters the field while ordinary brake creeps inward', () => {
  const held = fly(shipAt(54, 0), { hold: true }, { field }, 5);
  const brake = fly(shipAt(54, 0), { brake: true }, { field }, 5);
  assert(distance(held.position, { x: 54, y: 0, z: 0 }) < .5);
  assert(brake.position.x < 53);
});
test('30, 60 and 144 Hz simulate the same controls and deterministic surface buffet', () => {
  const molecule = { id: 'src', molecularMass: 4000, effMass: 4000, clusterRadius: 100, center: { x: 0, y: 0, z: 0 }, temperature: 1 };
  const molecular = chemistryField({ molecules: [molecule], gravity: 10, edgeRadius: 300 });
  for (const current of [field, molecular]) {
    const run = (fps) => fly(shipAt(30, 20), { thrust: .4, turn: .2, lift: .2 }, { field: current }, 5, fps);
    const expected = run(120);
    for (const fps of [30, 60, 144]) {
      const actual = run(fps);
      assert(distance(actual.position, expected.position) < 1e-8);
      assert(distance(actual.velocity, expected.velocity) < 1e-8);
    }
  }
});
test('surface floor, gravity, lift, edge and physics-off contacts work together', () => {
  const world = { floor: C.SURFACE_FLOOR, field: chemistryField({ molecules: [], gravity: C.G_SURFACE_MAX, edgeRadius: 100 }) };
  const sinking = fly(shipAt(0, 30), {}, world, 3);
  assert.equal(sinking.position.y, C.SURFACE_FLOOR + C.SHIP_RADIUS);
  const rising = fly(shipAt(0, 5), { lift: 1 }, world, 3);
  assert(rising.position.y > 15);
  const light = fly(shipAt(0, 30), {}, { field: chemistryField({ molecules: [], gravity: 0 }) }, 3);
  assert.equal(light.position.y, 30);
  const edge = fly(shipAt(150, 10), {}, world, 5);
  assert(edge.position.x < 120);
  const off = fly(shipAt(50, 30), {}, world, 3, 60, { field: false });
  assert.deepEqual(off.position, { x: 50, y: 30, z: 0 });
  const under = shipAt(0, -10);
  stepShip(under, {}, world, .1, { field: false });
  assert.equal(under.position.y, C.SURFACE_FLOOR + C.SHIP_RADIUS);
});
test('surface colliders contain atom ellipsoids at boost and the speed cap stays bounded', () => {
  const ship = shipAt(0, 15); ship.yaw = 0; ship.velocity.y = -150;
  const world = { colliders: [{ center: { x: 0, y: 3, z: 0 }, radius: 2.7, kind: 'ellipsoid', scaleY: 1.5 }] };
  stepShip(ship, { lift: -1, boost: true }, world, .1, { field: false });
  assert(ship.position.y >= 3 + 2.7 * 1.5 + C.SHIP_RADIUS);
  const speedy = fly(shipAt(0, 5), { lift: 1, thrust: 1, boost: true }, {}, 20);
  assert(Math.hypot(...Object.values(speedy.velocity)) <= 150);
});

test('a refreshed atom overlapping a grounded ship cannot pin it below the atom', () => {
  const ship = shipAt(0, C.SURFACE_FLOOR + C.SHIP_RADIUS);
  const world = { floor: C.SURFACE_FLOOR, colliders: [{ id: 'new-atom', kind: 'ellipsoid', center: { x: 0, y: 4.7, z: 0 }, radius: 2.7, scaleY: 1.5 }] };
  fly(ship, { lift: 1, boost: true }, world, 2, 60, { field: false });
  assert(ship.position.y > 20);
  assert(Math.hypot(ship.position.x, ship.position.z) > 3);
});

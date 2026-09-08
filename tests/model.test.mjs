import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, stepShip, findNearestFile, findProbeTarget, createProbe, stepProbe, formatBytes } from '../public/model.js';

const file = (path, size = 1024) => ({ path, name: path.split('/').at(-1), size, modifiedAt: '2026-09-07T00:00:00Z' });
const snapshot = (files) => ({ root: { name: 'My folder' }, scannedAt: '2026-09-07T12:00:00Z', files });
const newShip = () => ({ position: { x: 0, y: 12, z: 100 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0 });

test('file locations survive file additions and snapshot input reordering', () => {
  const before = buildWorld(snapshot([file('src/a.js'), file('src/b.js'), file('docs/readme.md')]));
  const after = buildWorld(snapshot([file('docs/readme.md'), file('src/new.js'), file('src/b.js'), file('src/a.js')]));
  for (const original of before.files) {
    assert.deepEqual(after.files.find((candidate) => candidate.path === original.path).position, original.position);
  }
  assert.deepEqual(buildWorld(snapshot([file('src/b.js'), file('src/a.js')])), buildWorld(snapshot([file('src/a.js'), file('src/b.js')])));
});

test('metadata affects visual mass and recency while island count stays bounded', () => {
  const files = Array.from({ length: 40 }, (_, index) => file(`folder-${index}/data.bin`, 2 ** index));
  const world = buildWorld(snapshot(files));
  assert.equal(world.sectors.length, 24);
  assert.equal(world.files.length, 40);
  assert(world.files.every((item) => item.mass >= 1 && item.mass <= 12 && item.activity >= 0 && item.activity <= 1));
  assert(world.sectors.every((sector) => sector.radius >= 24 && sector.radius <= 48));
  assert(world.bounds > 0);
});

test('constant controls are independent of ordinary display frame rates', () => {
  const run = (fps) => {
    const ship = newShip();
    for (let frame = 0; frame < fps * 2; frame++) stepShip(ship, { thrust: 1, turn: 0.2 }, {}, 1 / fps, { currents: false });
    return ship;
  };
  const at30 = run(30);
  const at60 = run(60);
  assert(Math.hypot(at30.position.x - at60.position.x, at30.position.y - at60.position.y, at30.position.z - at60.position.z) < 0.001);
  assert(Math.abs(at30.yaw - at60.yaw) < 0.00001);
  assert(at60.position.z < 100);
  assert(at60.position.x < 0);
});

test('small file collision prevents a boosted ship tunneling through a file', () => {
  const ship = newShip();
  ship.position = { x: 0, y: 0, z: 6 };
  ship.velocity.z = -120;
  const world = { files: [{ position: { x: 0, y: 0, z: 0 }, radius: 0.9 }] };
  stepShip(ship, { thrust: 1, boost: true }, world, 0.1, { currents: false });
  assert(ship.position.z >= 2.3);
  assert(ship.velocity.z > -120);
});

test('vertical collision encloses the rendered crystal tip', () => {
  const ship = newShip();
  ship.position = { x: 0, y: 10, z: 0 };
  ship.velocity.y = -100;
  const crystal = { position: { x: 0, y: 0, z: 0 }, radius: 2.7, mass: 12 };
  stepShip(ship, { lift: -1, boost: true }, { files: [crystal] }, 0.1, { currents: false });
  const visibleTip = crystal.radius * (1.3 + crystal.mass * 0.08);
  assert(ship.position.y >= visibleTip + 1.4);
});

test('larger files exert a stronger but bounded local pull; currents can be disabled', () => {
  const fly = (mass, currents = true, count = 1) => {
    const ship = newShip();
    ship.position = { x: 10, y: 0, z: 0 };
    const crystal = { position: { x: 0, y: 0, z: 0 }, radius: 1, mass };
    stepShip(ship, {}, { files: Array(count).fill(crystal) }, 0.1, { currents });
    return ship;
  };
  const small = fly(1);
  const large = fly(12);
  const disabled = fly(12, false);
  assert(small.velocity.x < 0);
  assert(large.velocity.x < small.velocity.x);
  assert.equal(disabled.velocity.x, 0);
  assert(Math.abs(fly(12, true, 2000).velocity.x) < 0.121);
});

test('exact-center collision, invalid state, and delayed frames remain finite', () => {
  const ship = { position: { x: NaN, y: 0, z: 0 }, velocity: { x: Infinity, y: 0, z: 0 }, yaw: NaN };
  const world = { files: [{ position: { x: 0, y: 0, z: 0 }, radius: 1 }] };
  stepShip(ship, {}, world, 4);
  assert([...Object.values(ship.position), ...Object.values(ship.velocity), ship.yaw].every(Number.isFinite));
  assert(Math.hypot(ship.position.x, ship.position.y, ship.position.z) >= 2.4);
  const normal = newShip();
  const delayed = newShip();
  stepShip(normal, { thrust: 1 }, {}, 0.1);
  stepShip(delayed, { thrust: 1 }, {}, 20);
  assert.deepEqual(delayed, normal);
});

test('empty folders and nearest-file distance limits are safe', () => {
  const empty = buildWorld(snapshot([]));
  assert.deepEqual(empty.files, []);
  assert.deepEqual(empty.center, { x: 0, y: 0, z: 0 });
  assert.equal(findNearestFile(empty, { x: 0, y: 0, z: 0 }), null);
  const world = buildWorld(snapshot([file('hello.txt')]));
  assert.equal(findNearestFile(world, world.files[0].position), world.files[0]);
  assert.equal(findNearestFile(world, { x: 0, y: 0, z: 0 }, 1), null);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('probe targeting chooses the closest file within the aim cone', () => {
  const files = [
    { id: 'near', position: { x: 0, y: 0, z: -30 } },
    { id: 'far', position: { x: 0, y: 0, z: -80 } },
    { id: 'wide', position: { x: 5, y: 0, z: -30 } },
  ];
  const target = findProbeTarget(files, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { angularTolerance: .04 });
  assert.equal(target.file.id, 'near');
  assert.equal(Math.round(target.distance), 30);
  assert.equal(findProbeTarget(files, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { angularTolerance: .04, maxDistance: 20 }), null);
});

test('probes reject out-of-range targets and arrive over a bounded travel time', () => {
  const target = { id: 'readme', position: { x: 0, y: 0, z: -80 } };
  assert.equal(createProbe({ x: 0, y: 0, z: 0 }, target, 60), null);
  const probe = createProbe({ x: 0, y: 0, z: 0 }, target, 100);
  assert(probe.duration >= .3 && probe.duration <= .8);
  assert.equal(stepProbe(probe, probe.duration / 2), false);
  assert.deepEqual(probe.position, { x: 0, y: 0, z: -40 });
  assert.equal(stepProbe(probe, probe.duration), true);
  assert.deepEqual(probe.position, target.position);
});

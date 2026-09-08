import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, stepShip, findNearestFile, findScanCandidate, createFileShot, stepFileShot, SCAN_RANGE, SHOT_RANGE, formatBytes } from '../public/model.js';

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
    for (let frame = 0; frame < fps * 2; frame++) stepShip(ship, { thrust: 1, turn: 0.2 }, {}, 1 / fps, { field: false });
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
  stepShip(ship, { thrust: 1, boost: true }, world, 0.1, { field: false });
  assert(ship.position.z >= 2.3);
  assert(ship.velocity.z > -120);
});

test('vertical collision encloses the rendered crystal tip', () => {
  const ship = newShip();
  ship.position = { x: 0, y: 10, z: 0 };
  ship.velocity.y = -100;
  const crystal = { position: { x: 0, y: 0, z: 0 }, radius: 2.7, mass: 12 };
  stepShip(ship, { lift: -1, boost: true }, { files: [crystal] }, 0.1, { field: false });
  const visibleTip = crystal.radius * (1.3 + crystal.mass * 0.08);
  assert(ship.position.y >= visibleTip + 1.4);
});

test('legacy file metadata no longer adds an implicit attraction force', () => {
  const ship = newShip();
  ship.position = { x: 10, y: 0, z: 0 };
  stepShip(ship, {}, { files: [{ position: { x: 0, y: 0, z: 0 }, radius: 1, mass: 12 }] }, .1);
  assert.equal(ship.velocity.x, 0);
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

const signal = (id, x, y, z) => ({ id, position: { x, y, z } });
const aimShip = (yaw = 0) => ({ position: { x: 0, y: 0, z: 0 }, yaw });
const atAngle = (id, angle, distance) => signal(id, -Math.sin(angle) * distance, 0, -Math.cos(angle) * distance);

test('ranged shots hit centred signals through the inclusive 90-unit limit', () => {
  for (const range of [SCAN_RANGE + 1, 60, SHOT_RANGE]) {
    const target = signal('target', 0, 0, -range);
    assert.equal(findScanCandidate({ files: [target] }, aimShip()), target);
  }
  assert.equal(findScanCandidate({ files: [] }, aimShip()), null);
  assert.equal(findScanCandidate(null, aimShip()), null);
});

test('ranged shots miss off-axis, rearward, and out-of-range signals', () => {
  const targets = [atAngle('off-axis', 12.1 * Math.PI / 180, 50), signal('behind', 0, 0, 50), signal('distant', 0, 0, -SHOT_RANGE - .01)];
  for (const target of targets) assert.equal(findScanCandidate({ files: [target] }, aimShip()), null);
  assert.equal(findScanCandidate({ files: targets }, aimShip()), null);
});

test('shot heading follows ship yaw, including wrapping across pi', () => {
  for (const yaw of [Math.PI / 2, -Math.PI / 2, Math.PI - .01, -Math.PI + .01]) {
    const target = atAngle('target', yaw + .02, 60);
    assert.equal(findScanCandidate({ files: [target] }, aimShip(yaw)), target);
  }
  const edge = atAngle('edge', 12 * Math.PI / 180, 50);
  assert.equal(findScanCandidate({ files: [edge] }, aimShip()), edge);
});

test('ranged shots tolerate altitude without turning the yaw test into a 3D cone', () => {
  for (const y of [-30, 30]) {
    const target = signal('target', 0, y, -40);
    assert.equal(findScanCandidate({ files: [target] }, aimShip()), target);
  }
  for (const target of [signal('too high', 0, 30.01, -40), signal('overhead', 0, 30, 0), signal('3D range', 0, 30, -89)]) {
    assert.equal(findScanCandidate({ files: [target] }, aimShip()), null);
  }
});

test('ranged selection prefers angular accuracy over distance in either file order', () => {
  const centred = atAngle('centred', 2 * Math.PI / 180, 80);
  const closer = atAngle('closer', 10 * Math.PI / 180, 25);
  for (const files of [[centred, closer], [closer, centred]]) {
    assert.equal(findScanCandidate({ files }, aimShip()), centred);
  }
  const equallyCentred = atAngle('same angle', 2 * Math.PI / 180, 40);
  assert.equal(findScanCandidate({ files: [centred, equallyCentred] }, aimShip()), equallyCentred);
});

test('nearby files retain no-aim opening and priority over ranged shots', () => {
  const nearby = signal('nearby', SCAN_RANGE, 0, 0);
  const ranged = signal('ranged', 0, 0, -60);
  assert.equal(findScanCandidate({ files: [ranged, nearby] }, aimShip(), ranged.id), nearby);
  const nearer = signal('nearer', 0, 0, 10);
  assert.equal(findScanCandidate({ files: [nearby, nearer] }, aimShip()), nearer);
  assert.equal(findScanCandidate({ files: [nearby, nearer] }, aimShip(), nearby.id), nearby);
});

test('focus stays locked within shot range, with fallback when out of range or removed', () => {
  const centred = signal('centred', 0, 0, -40);
  const focused = atAngle('focused', 10 * Math.PI / 180, 80);
  assert.equal(findScanCandidate({ files: [centred, focused] }, aimShip(), focused.id), focused);
  const offAxis = signal('focused', 50, 0, 0);
  assert.equal(findScanCandidate({ files: [centred, offAxis] }, aimShip(), offAxis.id), offAxis);
  const distant = signal('focused', 0, 0, -91);
  assert.equal(findScanCandidate({ files: [centred, distant] }, aimShip(), distant.id), centred);
  assert.equal(findScanCandidate({ files: [centred] }, aimShip(), 'removed'), centred);
});

test('ranged shots snapshot a nose launch point and target while the ship keeps moving', () => {
  const ship = { position: { x: 10, y: 12, z: 70 }, yaw: Math.PI / 2 };
  const target = signal('target', -50, 20, 70);
  const shot = createFileShot(ship, target);
  assert(Math.abs(shot.start.x - 4.6) < 1e-10);
  assert.equal(shot.start.y, 12.6);
  assert.equal(shot.start.z, 70);
  assert.deepEqual(shot.end, target.position);
  ship.position.x = 100;
  target.position.x = 200;
  assert(Math.abs(shot.start.x - 4.6) < 1e-10);
  assert.equal(shot.end.x, -50);
  assert.equal(shot.phase, 'flight');
  assert.equal(shot.progress, 0);
});

test('shots take visible travel time, with longer flights for distant signals', () => {
  const close = createFileShot(aimShip(), signal('close', 0, 0, -19));
  const distant = createFileShot(aimShip(), signal('distant', 0, 0, -SHOT_RANGE));
  assert.equal(close.duration, .45);
  assert(distant.duration > .8 && distant.duration < 1);
  assert.equal(stepFileShot(distant, .1), null);
  assert(distant.progress > 0 && distant.progress < 1);
  assert.equal(distant.phase, 'flight');
});

test('a shot emits one impact, holds it visibly, then opens exactly once', () => {
  const shot = createFileShot(aimShip(), signal('target', 0, 0, -90));
  while (shot.progress + .1 / shot.duration < 1) assert.equal(stepFileShot(shot, .1), null);
  assert.equal(stepFileShot(shot, .1), 'impact');
  assert.equal(shot.progress, 1);
  assert.equal(shot.phase, 'impact');
  assert.equal(shot.age, 0);
  assert.equal(stepFileShot(shot, .1), null);
  assert.equal(shot.phase, 'impact');
  assert.equal(stepFileShot(shot, .1), 'open');
  assert.equal(shot.phase, 'complete');
  for (let frame = 0; frame < 10; frame++) assert.equal(stepFileShot(shot, .1), null);
});

test('zero time pauses a shot and delayed frames cannot skip the impact beat', () => {
  const shot = createFileShot(aimShip(), signal('target', 0, 0, -19));
  const initial = structuredClone(shot);
  assert.equal(stepFileShot(shot, 0), null);
  assert.deepEqual(shot, initial);
  for (let frame = 0; frame < 4; frame++) assert.equal(stepFileShot(shot, 10), null);
  assert.equal(stepFileShot(shot, 10), 'impact');
  assert.equal(stepFileShot(shot, 10), null);
  assert.equal(shot.phase, 'impact');
  assert.equal(stepFileShot(shot, 10), 'open');
});

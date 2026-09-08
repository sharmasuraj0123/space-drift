import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpaceWorld, buildPlanetWorld, bodyRadius, atomRadius, moleculeAt, childMoleculeAt, refreshWorldPhysics } from '../public/bodies.js';
import * as C from '../public/constants.js';
const now = Date.parse('2026-09-08T12:00:00Z');
const makeBody = (id, restMass = 1000, extra = {}) => ({ id, path: id, name: id.split('/').at(-1), kind: 'planet', restMass, excitation: 0, excitationAt: now, survey: { pending: false }, ...extra });
const makeAtom = (path, atomicMass = 1000, extra = {}) => ({ id: path, path, name: path.split('/').at(-1), atomicMass, element: 'source', excitation: 0, excitationAt: now, ...extra });
function payload(atoms) { return { id: '.', atoms, restMass: atoms.reduce((n, a) => n + a.atomicMass, 0) }; }
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (a, b) => assert(Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(b)));

test('world builders retain canonical atom ids, nested repositories and additive molecular mass', () => {
  const atoms = [makeAtom('README.md'), makeAtom('src/a.js', 2000), makeAtom('src/nested/b.js', 3000)];
  const p = { ...payload(atoms), molecules: [{ id: 'src/nested', parentId: 'src', repo: true, worktree: true }] };
  const space = buildSpaceWorld({ bodies: [makeBody('.', p.restMass)] }, now);
  const world = buildPlanetWorld(p, space, now);
  assert.equal(world.atoms.length, 3);
  assert.equal(world.molecules.find((m) => m.id === '.').molecularMass, space.bodies[0].restMass);
  assert.equal(world.molecules.find((m) => m.id === 'src').molecularMass, 5000);
  assert.equal(world.molecules.find((m) => m.id === 'src').atomCount, 2);
  assert.equal(world.molecules.find((m) => m.id === 'src').elements.source, 2);
  assert.equal(world.molecules.find((m) => m.id === 'src/nested').repo, true);
  assert.equal(world.molecules.find((m) => m.id === 'src/nested').worktree, true);
  assert.deepEqual(world.atoms.map((a) => a.id), atoms.map((a) => a.id));
  for (const a of world.atoms) assert.equal(world.molecules.filter((m) => m.atomIds.includes(a.id)).length, 1);
  assert.equal(world.moleculeBonds.length, world.molecules.length - 1);
  const reordered = buildPlanetWorld({ ...p, atoms: [...atoms].reverse() }, space, now);
  for (const key of ["atoms", "molecules", "bonds", "moleculeBonds", "landing"]) assert.deepEqual(reordered[key], world[key]);
  assert(world.molecules.every((m) => Number.isFinite(m.illumination) && m.color.length === 3));
});

test('chord-safe rings keep 100 random surface hierarchies disjoint and bounded', () => {
  for (let seed = 0; seed < 100; seed++) {
    const atoms = Array.from({ length: 25 + seed % 60 }, (_, i) => makeAtom(`${i % 5 ? 'folder-' + i % 5 + '/' : ''}${i % 7 === 1 ? 'nested/' : ''}file-${i}.js`, 2 ** ((i * 7 + seed) % 31)));
    const world = buildPlanetWorld(payload(atoms), {}, now);
    for (let i = 0; i < world.atoms.length; i++) {
      const a = world.atoms[i]; near(a.position.y, C.SURFACE_FLOOR + a.radius);
      assert(Math.hypot(a.position.x, a.position.z) + a.radius < world.surfaceRadius);
      for (let j = i + 1; j < world.atoms.length; j++) assert(distance(a.position, world.atoms[j].position) >= a.radius + world.atoms[j].radius - 1e-8);
    }
    for (const parent of world.molecules) {
      const slots = parent.slots;
      for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
        assert(distance(slots[i].local, slots[j].local) >= slots[i].slotRadius + slots[j].slotRadius - 1e-8, `overlap seed ${seed}: ${slots[i].id}, ${slots[j].id}`);
      }
    }
  }
});

test('landing always faces a nearby clear root atom or safe nested fallback', () => {
  for (const atoms of [[makeAtom('README.md', 1e10)], [makeAtom('src/a.js', 1e10)], Array.from({ length: 2500 }, (_, i) => makeAtom(`file-${String(i).padStart(4, '0')}.js`, i * 1000))]) {
    const world = buildPlanetWorld(payload(atoms), {}, now), target = world.atoms.find((a) => a.id === world.landingTargetId);
    assert(Math.hypot(target.position.x - world.landing.x, target.position.y - world.landing.y, target.position.z - world.landing.z) < C.OPEN_RANGE);
    const bearing = Math.atan2(world.landing.x - target.position.x, world.landing.z - target.position.z);
    near(world.landingYaw, bearing);
    for (const a of world.atoms) {
      assert(Math.hypot((world.landing.x - a.position.x) / (a.radius + C.SHIP_RADIUS), (world.landing.y - a.position.y) / (1.5 * a.radius + C.SHIP_RADIUS), (world.landing.z - a.position.z) / (a.radius + C.SHIP_RADIUS)) > 1);
      assert(Math.hypot(a.position.x, a.position.z) + a.radius < world.surfaceRadius);
    }
  }
});

test('space groups keep rest landing footprints clear across 100 skewed mass fixtures', () => {
  for (let seed = 0; seed < 100; seed++) {
    const bodies = Array.from({ length: 3 + seed % 62 }, (_, i) => makeBody(i % 3 ? `group-${i % 4}/repo-${i}` : `repo-${i}`, i === 0 ? 1024 ** 3 : 2 ** ((seed + i * 5) % 30), i === 1 ? { survey: { pending: true }, restMass: 0 } : {}));
    bodies.push(makeBody('belt', 500, { kind: 'belt' }));
    const world = buildSpaceWorld({ bodies }, now);
    assert.equal(world.groups[0].belt, true);
    assert.deepEqual(world.groups[0].center, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < world.bodies.length; i++) for (let j = i + 1; j < world.bodies.length; j++) {
      const a = world.bodies[i], b = world.bodies[j];
      assert(distance(a.center, b.center) >= a.restLandingRadius + b.restLandingRadius - 1e-8);
    }
    for (const group of world.groups) for (const b of group.members) near(distance(b.center, group.center), group.ringRadius);
    const reordered = buildSpaceWorld({ bodies: [...bodies].reverse() }, now);
    for (const key of ["bodies", "groups", "launch", "bounds"]) assert.deepEqual(reordered[key], world[key]);
  }
});

test('established slots survive earlier additions and excitation; footprint growth repacks safely', () => {
  const original = [makeBody('middle', 1000), makeBody('zebra', 2000)];
  const before = buildSpaceWorld({ bodies: original }, now);
  const after = buildSpaceWorld({ bodies: [makeBody('aardvark', 100), ...original.map((b) => ({ ...b, excitation: b.restMass }))] }, now, before);
  for (const a of before.bodies) assert.deepEqual(after.bodies.find((b) => b.id === a.id).center, a.center);
  const grown = buildSpaceWorld({ bodies: after.bodies.map((b) => ({ ...b, restMass: b.id === 'middle' ? 1e12 : b.restMass })) }, now, after);
  for (let i = 0; i < grown.bodies.length; i++) for (let j = i + 1; j < grown.bodies.length; j++) assert(distance(grown.bodies[i].center, grown.bodies[j].center) >= grown.bodies[i].restLandingRadius + grown.bodies[j].restLandingRadius);
});

test('bonds and innermost molecule lookups are deterministic with degree bounds', () => {
  const atoms = Array.from({ length: 50 }, (_, i) => makeAtom(`src/nested/file-${i}.js`));
  const world = buildPlanetWorld(payload(atoms), {}, now), nested = world.molecules.find((m) => m.id === 'src/nested');
  assert.equal(moleculeAt(world, nested.center).id, 'src/nested');
  assert.equal(childMoleculeAt(world, nested.center).id, 'src/nested');
  assert.equal(childMoleculeAt(world, { x: 0, z: 0 }), null);
  assert.equal(moleculeAt(world, { x: 1e9, z: 0 }), null);
  for (const atom of atoms) assert(world.bonds.filter((b) => b.a === atom.id || b.b === atom.id).length <= C.MAX_BONDS_PER_ATOM);
  assert(world.bonds.every((b) => b.order === 2));
  assert.deepEqual(buildPlanetWorld(payload([...atoms].reverse()), {}, now).bonds, world.bonds);
});

test('sizes stay finite and continuous decay updates fields without moving geometry', () => {
  assert.equal(bodyRadius(0), C.R_MIN); assert.equal(bodyRadius(1e99), C.R_MAX);
  assert.equal(atomRadius(0), .9); assert.equal(atomRadius(1e99), 2.7);
  assert.equal(Object.keys(C.ELEMENT_COLORS).length, 7);
  const space = buildSpaceWorld({ bodies: [makeBody('.', 10000, { excitation: 10000 })] }, now);
  const planet = buildPlanetWorld(payload([makeAtom('src/a.js', 10000, { excitation: 10000 })]), space, now);
  const positions = JSON.stringify([space.bodies.map((b) => b.center), planet.atoms.map((a) => a.position)]);
  const p = { x: space.bodies[0].center.x + 100, y: 0, z: space.bodies[0].center.z };
  const before = Math.abs(space.field.acceleration(p).x), field = space.field;
  refreshWorldPhysics(space, planet, now + C.HALF_LIFE_MS, .1);
  near(space.bodies[0].effMass, 15000); near(planet.atoms[0].effMass, 15000);
  near(Math.abs(space.field.acceleration(p).x), before * .75);
  assert.equal(space.field, field);
  assert.equal(JSON.stringify([space.bodies.map((b) => b.center), planet.atoms.map((a) => a.position)]), positions);
  const changed = buildSpaceWorld({ bodies: [...space.payload.bodies, makeBody('heavy', 1e8)] }, now, space);
  const initial = changed.system.G, target = changed.targetSystem.G;
  assert.notEqual(initial, target);
  refreshWorldPhysics(changed, null, now, .5); near(changed.system.G, (initial + target) / 2);
  refreshWorldPhysics(changed, null, now, .5); near(changed.system.G, target);
  assert.equal(changed.systemTransition, null);
});

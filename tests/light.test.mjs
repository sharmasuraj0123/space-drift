import test from 'node:test';
import assert from 'node:assert/strict';
import { HALF_LIFE_MS, LAMBDA_DAY, L_MIN, ELEMENT_COLORS } from '../public/constants.js';
import { luminosity, emits, emissionColor, bodyColor, irradiance, illumination, skyStars, flashesFrom, coolingFrom, rgb } from '../public/light.js';
import * as THREE from 'three';
import { createLightRenderer } from '../public/render-light.js';
import { createSpaceRenderer } from '../public/render-space.js';
import { createPlanetRenderer } from '../public/render-planet.js';
const now = 1700000000000;
const atom = (id, excitation, extra = {}) => ({ id, atomicMass: excitation, excitation, excitationAt: now, element: 'source', ...extra });
test('light decays in bytes/day independently of system constants', () => {
  const file = atom('a', 12290);
  assert.equal(luminosity(file, now), LAMBDA_DAY * 12290);
  assert.equal(luminosity(file, now + HALF_LIFE_MS), luminosity(file, now) / 2);
  assert.ok(emits(file, now + 1.58 * HALF_LIFE_MS));
  assert.ok(!emits(file, now + 1.59 * HALF_LIFE_MS));
  assert.equal(luminosity({ ...file, cSquared: 2 }, now), luminosity({ ...file, cSquared: 500 }, now));
  assert.equal(luminosity(atom('bad', -10), now), 0);
});
test('aggregate luminosity and color retain sub-threshold contributors', () => {
  const atoms = [atom('a', 3000), atom('b', 3000, { element: 'markup' })];
  const body = atom('body', 6000);
  assert.ok(atoms.every((a) => luminosity(a, now) < L_MIN)); assert.ok(emits(body, now));
  for (const t of [now, now + HALF_LIFE_MS, now + 3 * HALF_LIFE_MS]) assert.ok(Math.abs(luminosity(body, t) - atoms.reduce((sum, a) => sum + luminosity(a, t), 0)) < 1e-9);
  const color = bodyColor(body, atoms, now);
  assert.ok(color.every(Number.isFinite));
  bodyColor(body, [atoms[0], atom('cold', 0)], now).forEach((c, i) => assert.ok(Math.abs(c - emissionColor(atoms[0], now)[i]) < 1e-12));
});
test('element spectra approach blue-white monotonically as excitation rises', () => {
  const cold = atom('a', 0, { atomicMass: 1000, element: 'markup' });
  assert.deepEqual(emissionColor(cold, now), rgb(ELEMENT_COLORS.markup));
  const mid = emissionColor({ ...cold, excitation: 500 }, now), hot = emissionColor({ ...cold, excitation: 1000 }, now);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(mid[i] - hot[i]) <= Math.abs(emissionColor(cold, now)[i] - hot[i]));
  assert.deepEqual(hot, [.9, .96, 1]);
});
test('irradiance and sky bearings come from neighboring bodies only', () => {
  assert.equal(irradiance(100, 20), irradiance(100, 10) / 4);
  assert.ok(Number.isFinite(irradiance(100, 0)));
  const a = atom('a', 0, { center: { x: 0, y: 0, z: 0 } });
  const b = atom('b', 12000, { center: { x: 30, y: 0, z: 40 } });
  assert.ok(illumination(a, [a, b], now) > illumination(a, [a], now));
  assert.deepEqual(skyStars(a, [a, b], now)[0].bearing, { x: .6, y: 0, z: .8 });
});
test('flashes need a measured rise; cooling expires and never emits', () => {
  const previous = new Map([['a', 10]]);
  assert.equal(flashesFrom([{ path: 'a', excitation: 20, at: now }], previous, now).length, 1);
  assert.equal(flashesFrom([{ path: 'a', excitation: 10, at: now }], previous, now).length, 0);
  assert.equal(flashesFrom([{ path: 'new', excitation: 10, at: now }], previous, now).length, 0);
  assert.equal(coolingFrom([{ type: 'deleted', path: 'a', at: now }], now + 1250)[0].intensity, .5);
  assert.equal(coolingFrom([{ type: 'deleted', path: 'a', at: now }], now)[0].emits, false);
  assert.deepEqual(coolingFrom([{ type: 'deleted', path: 'a', at: now }], now + 2500), []);
});
test('render lights enforce the budget and reset baselines between sources', () => {
  const lighting = createLightRenderer({ THREE, group: new THREE.Group(), excludeRoot: true });
  const bodies = Array.from({ length: 12 }, (_, i) => atom(String(i), 10000 + i * 1000));
  lighting.setBodies([atom('.', 999999), ...bodies], now, bodies);
  const snapshot = lighting.update({ now });
  assert.equal(snapshot.pointLights, 8);
  assert.equal(lighting.group.children.filter((item) => item.isPointLight && item.visible).length, 8);
  assert.equal(snapshot.emitters.some((item) => item.id === '.'), false);
  lighting.setBodies([...bodies, atom('created', 5000)], now + 100);
  assert.equal(lighting.update({ now: now + 100 }).flashes[0].id, 'created');
  lighting.setBodies(bodies, now + 200);
  assert.equal(lighting.update({ now: now + 200 }).cooling[0].id, 'created');
  lighting.reset(); lighting.setBodies([atom('created', 10000)], now + 300);
  assert.deepEqual(lighting.update({ now: now + 300 }).flashes, []);
});
test('inactive layers release geometry, rebuild once, and dispose cleanly', () => {
  const grid = () => ({ resolution: 4, bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, heights: new Float32Array(16), curvature: new Float32Array(16) });
  const field = { sampleGrid: grid };
  const body = atom('body', 10000, { name: 'Body', kind: 'planet', center: { x: 0, y: 0, z: 0 }, radius: 10, landingRadius: 20, horizonRadius: 2, illumination: .04 });
  const space = { layer: 'space', bodies: [body], bounds: 100, field, now };
  const surface = { layer: 'planet', planetId: 'body', atoms: [atom('a', 10000, { position: { x: 0, y: 2, z: 0 }, radius: 1, moleculeId: '.' })], molecules: [], bonds: [], moleculeBonds: [], field, surfaceRadius: 40, floor: 2, now };
  const scene = new THREE.Scene(), a = createSpaceRenderer({ THREE, scene }), b = createPlanetRenderer({ THREE, scene });
  for (const [renderer, world] of [[a, space], [b, surface]]) {
    renderer.setWorld(world); renderer.update({ world, spaceWorld: space, now, dt: 1 / 60 });
    const count = renderer.group.children[0].children.length; assert.ok(count > 0);
    renderer.setVisible(false); assert.equal(renderer.group.children[0].children.length, 0);
    renderer.setWorld(world); assert.equal(renderer.group.children[0].children.length, 0);
    renderer.setVisible(true); renderer.update({ world, spaceWorld: space, now, dt: 1 / 60 });
    assert.equal(renderer.group.children[0].children.length, count);
    renderer.reset(); assert.equal(renderer.group.children[0].children.length, 0);
    renderer.dispose();
  }
  assert.equal(scene.children.length, 0);
});

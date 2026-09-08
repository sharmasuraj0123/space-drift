import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTarget, createProbe, stepProbe, PROBE_COOLDOWN } from '../public/probes.js';
const origin = { x: 0, y: 0, z: 0 }, ray = { x: 0, y: 0, z: -1 };
const atoms = [{ id: 'near', position: { x: 0, y: 0, z: -50 }, radius: 1 }, { id: 'far', position: { x: 0, y: 0, z: -180 }, radius: 1 }, { id: 'behind', position: { x: 0, y: 0, z: 5 } }];
test('ray-cone targeting selects the closest eligible object and bounds by ship distance', () => {
  assert.equal(selectTarget(atoms, origin, ray).id, 'near');
  assert.equal(selectTarget(atoms, origin, ray, origin, { range: 40 }), null);
  assert.equal(selectTarget(atoms, origin, { x: 1, y: 0, z: 0 }), null);
  assert.equal(selectTarget(atoms, origin, origin), null);
  assert.equal(selectTarget([{ id: 'p', center: { x: 0, y: 0, z: -400 }, radius: 30 }], origin, ray, origin, { range: 600 }).id, 'p');
});
test('probes have cooldown and range feedback and arrive by interpolation without changing targets', () => {
  const ship = { position: origin }, target = selectTarget(atoms, origin, ray);
  assert.match(createProbe(ship, null, 0).error, /No target/);
  assert.match(createProbe(ship, target, 0, 0).error, /recharging/);
  const far = selectTarget([atoms[1]], origin, ray);
  assert.match(createProbe(ship, far, 10).error, /out of probe range/);
  const { probe } = createProbe(ship, target, 10, 10 - PROBE_COOLDOWN - .01);
  assert.ok(probe.duration >= .3 && probe.duration <= .8);
  assert.equal(stepProbe(probe, 10).position.z, 0);
  assert.equal(stepProbe(probe, 10 + probe.duration / 2).arrived, false);
  assert.deepEqual(stepProbe(probe, 11).position, atoms[0].position);
  assert.equal(stepProbe(probe, 11).arrived, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createShotRenderer } from '../public/render-shot.js';

const shot = (extra = {}) => ({
  start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: -100 },
  distance: 100, phase: 'flight', progress: .5, age: .5, ...extra,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} ≈ ${b}`);

test('shot beam stays visible through tone mapping and reuses resources while travelling', () => {
  const scene = new THREE.Scene(), glow = new THREE.Texture();
  const renderer = createShotRenderer({ THREE, scene, glow });
  const group = scene.getObjectByName('file-shot');
  assert.equal(group.visible, false);
  assert.equal(group.children.length, 3);
  const beam = group.getObjectByName('beam');
  const head = group.getObjectByName('head');
  const resources = group.children.map((object) => [object, object.geometry, object.material]);
  const value = shot(), snapshot = structuredClone(value);
  renderer.update(value);
  assert.equal(group.visible, true);
  assert.equal(beam.visible, true);
  close(beam.position.z, -41);
  close(beam.scale.y, 18);
  close(head.position.z, -50);
  const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(beam.quaternion);
  close(direction.z, -1);
  for (let frame = 0; frame < 250; frame++) renderer.update(shot({ progress: frame / 250 }));
  assert.deepEqual(value, snapshot);
  assert.deepEqual(group.children.map((object) => [object, object.geometry, object.material]), resources);
  for (const object of group.children) {
    assert.equal(object.renderOrder, 10);
    assert.equal(object.material.toneMapped, false);
    assert.equal(object.material.depthTest, false);
    assert.equal(object.material.depthWrite, false);
    assert.equal(object.material.blending, THREE.AdditiveBlending);
  }
  renderer.dispose(); glow.dispose();
});

test('shots show a muzzle flash, then an impact beat, and disappear when cancelled or complete', () => {
  const scene = new THREE.Scene();
  const renderer = createShotRenderer({ THREE, scene });
  const group = scene.getObjectByName('file-shot');
  const beam = group.getObjectByName('beam'), head = group.getObjectByName('head');
  const muzzle = group.getObjectByName('muzzle');
  renderer.update(shot({ progress: 0, age: 0 }));
  assert.equal(beam.visible, false);
  assert.equal(muzzle.visible, true);
  assert.equal(muzzle.material.opacity, 1);
  renderer.update(shot({ progress: .2, age: .2 }));
  assert.equal(beam.visible, true);
  assert.equal(muzzle.visible, false);
  renderer.update(shot({ phase: 'impact', progress: 1, age: .1 }));
  assert.equal(group.visible, true);
  assert.equal(beam.visible, false);
  assert.equal(muzzle.visible, false);
  close(head.position.z, -100);
  close(head.scale.x, 8.5);
  close(head.material.opacity, .5);
  renderer.update(shot({ phase: 'complete', progress: 1, age: .2 }));
  assert.equal(group.visible, false);
  renderer.update(shot());
  assert.equal(group.visible, true);
  renderer.update(null);
  assert.equal(group.visible, false);
  renderer.dispose();
});

test('shot disposal releases owned resources once and preserves the shared glow texture', () => {
  const scene = new THREE.Scene(), glow = new THREE.Texture();
  const renderer = createShotRenderer({ THREE, scene, glow });
  const group = scene.getObjectByName('file-shot');
  const beam = group.getObjectByName('beam');
  const counts = { geometry: 0, material: 0, texture: 0 };
  beam.geometry.addEventListener('dispose', () => counts.geometry++);
  for (const object of group.children) object.material.addEventListener('dispose', () => counts.material++);
  glow.addEventListener('dispose', () => counts.texture++);
  renderer.update(shot()); renderer.dispose(); renderer.dispose(); renderer.update(shot());
  assert.deepEqual(counts, { geometry: 1, material: 3, texture: 0 });
  assert.equal(scene.children.length, 0);
  assert.equal(group.children.length, 0);
  assert.equal(group.visible, false);
  glow.dispose();
});

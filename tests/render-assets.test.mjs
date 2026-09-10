import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createModelLibrary } from '../public/model-assets.js';
import { createSpaceRenderer } from '../public/render-space.js';

test('excitation patches follow each rotated Blender terrain instead of being buried beneath it', async () => {
  const bytes = await readFile(new URL('../public/assets/models/space-drift.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const assets = createModelLibrary(gltf.scene);
  const now = Date.now();
  const bodies = Array.from({ length: 9 }, (_, i) => ({
    id: `body-${i}`, name: `Planet ${i}`, kind: 'planet', radius: 10,
    center: { x: 97 + i * 90, y: 32, z: -86 }, landingRadius: 35, horizonRadius: 0,
    restMass: 1000, excitation: 0, excitationAt: now,
    patches: Array.from({ length: 16 }, () => ({ share: 1 / 16, xi: .5 })),
  }));
  const field = { sampleGrid: () => ({ resolution: 4, bounds: { minX: -100, maxX: 1000, minZ: -200, maxZ: 100 }, heights: new Float32Array(16), curvature: new Float32Array(16) }) };
  const scene = new THREE.Scene();
  const renderer = createSpaceRenderer({ THREE, scene, assets });
  renderer.setWorld({ bodies, field, now });
  scene.updateMatrixWorld(true);
  const allModels = new Set(), orientations = new Set();
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3(), direction = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  for (const body of bodies) {
    const patches = scene.getObjectByName(`surface-patches:${body.id}`);
    assert.equal(patches.count, 16);
    const center = new THREE.Vector3(body.center.x, body.center.y, body.center.z);
    const planet = renderer.group.children[0].children.find(node => node.userData.modelAsset && node.position.equals(center));
    allModels.add(planet.userData.modelAsset);
    orientations.add(planet.rotation.y);
    for (let i = 0; i < patches.count; i++) {
      patches.getMatrixAt(i, matrix);
      point.setFromMatrixPosition(matrix).applyMatrix4(patches.matrixWorld);
      const distance = point.distanceTo(center);
      direction.copy(point).sub(center).normalize();
      ray.ray.origin.copy(center).addScaledVector(direction, body.radius * 1.2);
      ray.ray.direction.copy(direction).negate();
      const hit = ray.intersectObject(planet, true)[0];
      assert.ok(hit, 'Each marker sits over actual terrain');
      const surfaceDistance = hit.point.distanceTo(center);
      assert.ok(distance > surfaceDistance, `${planet.userData.modelAsset} patch ${i} must emerge from its crust`);
      assert.ok(distance - surfaceDistance < body.radius * .01, 'Markers remain embedded near the physical surface');
      assert.ok(distance <= body.radius * 1.01, 'Markers do not float away from the unit-radius model');
    }
  }
  assert.equal(allModels.size, 3, 'The regression check covers all authored terrains');
  assert.ok(orientations.size > 1, 'The regression check covers model rotation');
  renderer.dispose();
  assets.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createModelLibrary, atomModelName, MODEL_NAMES } from '../public/model-assets.js';
import { createPlanetRenderer } from '../public/render-planet.js';
import { disposeGroup } from '../public/render-common.js';

function sourceFixture() {
  const scene = new THREE.Scene(), root = new THREE.Group();
  root.name = 'sample'; root.position.x = 2; scene.add(root);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array(geometry.attributes.position.count).fill([.5, .8, 1]).flat(), 3));
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(.4, .5, .6), vertexColors: true, map: new THREE.Texture() });
  const first = new THREE.Mesh(geometry, material); first.position.y = 3;
  const second = new THREE.Mesh(geometry, material); second.position.y = -3;
  root.add(first, second);
  return { scene, root, geometry, material };
}

async function productionAssets() {
  const bytes = await readFile(new URL('../public/assets/models/space-drift.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  return createModelLibrary(gltf.scene);
}

test('model instances own their geometry, material, and texture while preserving authored sharing', () => {
  const source = sourceFixture(), library = createModelLibrary(source.scene, ['sample']);
  const first = library.instantiate('sample'), second = library.instantiate('sample');
  assert.equal(first.children[0].geometry, first.children[1].geometry);
  assert.equal(first.children[0].material, first.children[1].material);
  assert.notEqual(first.children[0].geometry, source.geometry);
  assert.notEqual(first.children[0].geometry, second.children[0].geometry);
  assert.notEqual(first.children[0].material.map, source.material.map);
  assert.notEqual(first.children[0].material.map, second.children[0].material.map);
  first.children[0].geometry.attributes.position.setX(0, 99);
  first.children[0].material.color.setRGB(0, 0, 0);
  let neighborDisposed = false;
  second.children[0].geometry.addEventListener('dispose', () => { neighborDisposed = true; });
  disposeGroup(first);
  assert.equal(neighborDisposed, false);
  assert.notEqual(second.children[0].geometry.attributes.position.getX(0), 99);
  assert.ok(second.children[0].material.color.r > 0);
  const third = library.instantiate('sample');
  assert.notEqual(third.children[0].geometry.attributes.position.getX(0), 99);
  disposeGroup(second); disposeGroup(third); library.dispose();
});

test('instanced geometry bakes authored transforms and material tint without aliasing source buffers', () => {
  const source = sourceFixture(), library = createModelLibrary(source.scene, ['sample']);
  const first = library.geometry('sample'), second = library.geometry('sample');
  assert.equal(first.attributes.position.count, 72);
  assert.equal(first.boundingBox.min.x, 1.5);
  assert.equal(first.boundingBox.max.x, 2.5);
  assert.equal(first.boundingBox.min.y, -3.5);
  assert.equal(first.boundingBox.max.y, 3.5);
  assert.ok(Math.abs(first.attributes.color.getX(0) - .2) < 1e-6);
  assert.ok(Math.abs(first.attributes.color.getY(0) - .4) < 1e-6);
  assert.ok(Math.abs(first.attributes.color.getZ(0) - .6) < 1e-6);
  first.attributes.position.setX(0, 100);
  first.attributes.color.setX(0, 0);
  assert.notEqual(second.attributes.position.getX(0), 100);
  assert.ok(second.attributes.color.getX(0) > 0);
  assert.equal(source.geometry.attributes.color.getX(0), .5);
  first.dispose(); second.dispose(); library.dispose();
  assert.throws(() => library.geometry('sample'), /disposed/);
});

test('file families cover real element names, aliases, and unknown formats', () => {
  const families = {
    atom_code: ['source', 'code'], atom_data: ['data', 'config'],
    atom_document: ['markup', 'text', 'document'], atom_media: ['image', 'media', 'audio', 'video'],
    atom_other: ['binary', 'other', 'future-type', undefined],
  };
  for (const [name, elements] of Object.entries(families)) for (const element of elements) assert.equal(atomModelName(element), name);
});

test('the shipped Blender pack contains all rigid models and normalized collision-safe matter', async () => {
  const assets = await productionAssets();
  assert.deepEqual(assets.names, MODEL_NAMES);
  for (const name of assets.names) {
    const geometry = assets.geometry(name), positions = geometry.attributes.position;
    assert.ok(positions.count > 12, `${name} has actual model detail`);
    assert.equal(geometry.attributes.color.count, positions.count);
    for (let i = 0; i < positions.count; i++) {
      const length = Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i));
      assert.ok(Number.isFinite(length));
      if (name !== 'explorer') assert.ok(length <= 1.002, `${name} must fit its unit collision envelope: ${length}`);
    }
    geometry.dispose();
  }
  assets.dispose();
});

test('surface matter stays instanced by family, aligns with colliders, and retains model-shaped cooling ghosts', async () => {
  const assets = await productionAssets(), now = Date.now();
  const elements = ['source', 'data', 'markup', 'image', 'binary'];
  const atoms = Array.from({ length: 2500 }, (_, i) => ({
    id: `file-${i}`, name: `file-${i}`, element: elements[i % elements.length],
    atomicMass: 1000, excitation: 0, excitationAt: now, moleculeId: 'signals',
    radius: 2, position: { x: i % 25 * 7, y: 4, z: Math.floor(i / 25) * 7 },
  }));
  const field = { sampleGrid: () => ({ resolution: 4, bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, heights: new Float32Array(16), curvature: new Float32Array(16) }) };
  const world = { layer: 'planet', planetId: 'test', atoms, molecules: [{ id: 'signals', name: 'Signals', center: { x: 0, y: 0, z: 0 }, clusterRadius: 25, molecularMass: 2500000, excitation: 0, excitationAt: now }], bonds: [], moleculeBonds: [], field, surfaceRadius: 220, now };
  const scene = new THREE.Scene(), renderer = createPlanetRenderer({ THREE, scene, assets });
  renderer.setWorld(world); renderer.update({ now, dt: 1 / 60 });
  const meshes = renderer.group.children[0].children.filter(node => node.name.startsWith('files:'));
  assert.equal(meshes.length, 5);
  assert.equal(meshes.reduce((sum, mesh) => sum + mesh.count, 0), 2500);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  for (const mesh of meshes) {
    assert.ok(mesh.isInstancedMesh);
    mesh.getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
    const atom = atoms.find(atom => atom.id === mesh.userData.atomIds[0]);
    assert.deepEqual(position.toArray(), [atom.position.x, atom.position.y, atom.position.z]);
    assert.ok(Math.abs(scale.x - 2) < 1e-6 && Math.abs(scale.y - 3) < 1e-6 && Math.abs(scale.z - 2) < 1e-6);
    assert.equal(mesh.geometry.attributes.emission.getX(0), 0, 'Cold files have no emissive light');
  }
  const updated = { ...world, atoms: atoms.slice(5), now: now + 100 };
  renderer.setWorld(updated); renderer.update({ world: updated, now: now + 100, dt: 1 / 60 });
  let ghosts = renderer.group.children[0].children.filter(node => node.name.startsWith('cooling:'));
  assert.equal(ghosts.length, 5);
  assert.equal(ghosts.reduce((sum, mesh) => sum + mesh.count, 0), 5);
  const recreated = { ...world, now: now + 200 };
  renderer.setWorld(recreated); renderer.update({ now: now + 200, dt: 1 / 60 });
  assert.equal(renderer.group.children[0].children.filter(node => node.name.startsWith('cooling:')).length, 0, 'A recreated file replaces its cooling ghost immediately');
  renderer.setWorld({ ...updated, now: now + 300 }); renderer.update({ now: now + 300, dt: 1 / 60 });
  ghosts = renderer.group.children[0].children.filter(node => node.name.startsWith('cooling:'));
  assert.equal(ghosts.reduce((sum, mesh) => sum + mesh.count, 0), 5);
  renderer.update({ now: now + 10000, dt: 1 / 60 });
  assert.ok(ghosts.every(mesh => !mesh.visible && mesh.count === 0));
  renderer.dispose(); assets.dispose();
  assert.equal(scene.children.length, 0);
});

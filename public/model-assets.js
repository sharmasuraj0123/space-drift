import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const MODEL_URL = '/assets/models/space-drift.glb';
export const MODEL_NAMES = Object.freeze([
  'explorer', 'planet_basalt', 'planet_ocean', 'planet_ice',
  'atom_code', 'atom_data', 'atom_document', 'atom_media', 'atom_other',
  'molecule', 'asteroid',
]);

export function atomModelName(element) {
  if (['source', 'code'].includes(element)) return 'atom_code';
  if (['data', 'config'].includes(element)) return 'atom_data';
  if (['markup', 'text', 'document'].includes(element)) return 'atom_document';
  if (['image', 'media', 'audio', 'video'].includes(element)) return 'atom_media';
  return 'atom_other';
}

/** Bake rigid authored parts into one draw call, retaining material and vertex tint. */
function bakeGeometry(root) {
  root.updateWorldMatrix(true, true);
  const parentInverse = root.parent ? root.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
  const parts = [];
  root.traverse(node => {
    if (!node.isMesh) return;
    if (node.isSkinnedMesh) throw new Error(`The model ${root.name} must use rigid geometry.`);
    const geometry = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone();
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3), original = geometry.attributes.color;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const paint = (start, end, material) => {
      const tint = material?.color || new THREE.Color(1, 1, 1);
      for (let i = start; i < Math.min(end, count); i++) {
        colors[i * 3] = tint.r * (original ? original.getX(i) : 1);
        colors[i * 3 + 1] = tint.g * (original ? original.getY(i) : 1);
        colors[i * 3 + 2] = tint.b * (original ? original.getZ(i) : 1);
      }
    };
    paint(0, count, materials[0]);
    for (const group of geometry.groups) paint(group.start, group.start + group.count, materials[group.materialIndex]);
    // UVs/material groups belong to the multipart model; instancing uses baked colors.
    for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal'].includes(name)) geometry.deleteAttribute(name);
    geometry.clearGroups();
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(parentInverse, node.matrixWorld));
    parts.push(geometry);
  });
  if (!parts.length) throw new Error(`The model ${root.name} contains no meshes.`);
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error(`The model ${root.name} could not be prepared for instancing.`);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Templates stay private. Every returned instance owns all of its GPU resources. */
export function createModelLibrary(scene, names = MODEL_NAMES) {
  const templates = new Map(names.map(name => {
    const node = scene.getObjectByName(name);
    if (!node) throw new Error(`Space Drift model pack is missing ${name}.`);
    return [name, node];
  }));
  const baked = new Map();
  let disposed = false;
  function template(name) {
    if (disposed) throw new Error('The Space Drift model library has been disposed.');
    if (!templates.has(name)) throw new Error(`Unknown Space Drift model: ${name}.`);
    return templates.get(name);
  }
  return Object.freeze({
    names: Object.freeze([...templates.keys()]),
    instantiate(name) {
      const copy = template(name).clone(true);
      const geometries = new Map(), materials = new Map(), textures = new Map();
      copy.traverse(node => {
        if (node.geometry) {
          if (!geometries.has(node.geometry)) geometries.set(node.geometry, node.geometry.clone());
          node.geometry = geometries.get(node.geometry);
        }
        const cloneMaterial = source => {
          if (!materials.has(source)) {
            const material = source.clone();
            for (const [key, value] of Object.entries(material)) if (value?.isTexture) {
              if (!textures.has(value)) textures.set(value, value.clone());
              material[key] = textures.get(value);
            }
            materials.set(source, material);
          }
          return materials.get(source);
        };
        if (node.material) node.material = Array.isArray(node.material) ? node.material.map(cloneMaterial) : cloneMaterial(node.material);
      });
      return copy;
    },
    geometry(name) {
      const root = template(name);
      if (!baked.has(name)) baked.set(name, bakeGeometry(root));
      return baked.get(name).clone();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of baked.values()) geometry.dispose();
      const resources = new Set();
      scene.traverse(node => {
        if (node.geometry) resources.add(node.geometry);
        for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) {
          resources.add(material);
          for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
        }
      });
      for (const resource of resources) resource.dispose();
      baked.clear();
      templates.clear();
    },
  });
}

export async function loadModelAssets(url = MODEL_URL) {
  const gltf = await new GLTFLoader().loadAsync(url);
  return createModelLibrary(gltf.scene);
}

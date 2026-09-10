import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');

// Deployment upload filters run before this script. Never publish a successful
// build when they have removed the models or images required by the browser.
for (const asset of ['assets/models/space-drift.glb', 'assets/social-card.png', 'assets/orbital-scene.webp']) {
  const info = await stat(path.join(root, 'public', asset)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`Missing required public asset: public/${asset}. Check .vercelignore; public/assets must be included in the deployment.`);
  }
}

async function copyPublic(directory, destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    // Hidden project metadata and symlinks never become public assets.
    if (entry.name.startsWith('.')) continue;
    const source = path.join(directory, entry.name);
    const target = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyPublic(source, target);
    else if (entry.isFile()) await copyFile(source, target);
    else throw new Error(`Unsupported public asset: ${path.relative(root, source)}`);
  }
}

await rm(output, { recursive: true, force: true });
await copyPublic(path.join(root, 'public'), output);
const vendor = path.join(output, 'vendor');
await mkdir(vendor, { recursive: true });
for (const filename of ['three.module.js', 'three.core.js']) {
  await copyFile(path.join(root, 'node_modules', 'three', 'build', filename), path.join(vendor, filename));
}
for (const filename of ['loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js']) {
  const destination = path.join(vendor, 'addons', filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, 'node_modules/three/examples/jsm', filename), destination);
}
await copyFile(path.join(root, 'node_modules', 'three', 'LICENSE'), path.join(vendor, 'three.LICENSE.txt'));
console.log('Space Drift static build ready in dist/.');

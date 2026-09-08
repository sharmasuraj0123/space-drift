import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');

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
await copyFile(path.join(root, 'node_modules', 'three', 'LICENSE'), path.join(vendor, 'three.LICENSE.txt'));
console.log('Space Drift static build ready in dist/.');

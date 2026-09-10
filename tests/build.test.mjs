import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ignore from 'ignore';

const project = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const privateSources = ['assets/source/game-assets.blend', 'assets/source/orbital-scene.blend', 'assets/screenshots/surface.png', 'docs/deployment.md', 'README.md'];
const vendorFiles = [
  ['build/three.module.js', 'vendor/three.module.js'],
  ['build/three.core.js', 'vendor/three.core.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'vendor/addons/loaders/GLTFLoader.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'vendor/addons/utils/BufferGeometryUtils.js'],
  ['examples/jsm/utils/SkeletonUtils.js', 'vendor/addons/utils/SkeletonUtils.js'],
  ['LICENSE', 'vendor/three.LICENSE.txt'],
];

async function filesAt(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const filename = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesAt(root, filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files.sort();
}

async function deploymentFixture(t, rules) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-drift-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const matcher = ignore().add(rules);
  const publicFiles = (await filesAt(path.join(project, 'public'))).map(filename => `public/${filename}`);
  const copy = async (source, filename) => {
    const destination = path.join(root, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  };

  // Model the upload before building: excluded source files never reach Vercel.
  for (const filename of ['scripts/build.mjs', ...publicFiles]) {
    if (!matcher.ignores(filename)) await copy(path.join(project, filename), filename);
  }
  for (const filename of privateSources) {
    if (!matcher.ignores(filename)) {
      await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await writeFile(path.join(root, filename), 'Synthetic editable source; excluded from deployment.');
    }
  }

  // Dependency installation happens after upload; only the build's Three inputs
  // are needed here, with no globally installed CLI or network dependency.
  for (const [source] of vendorFiles) {
    const filename = `node_modules/three/${source}`;
    await copy(path.join(project, filename), filename);
  }
  return { root, publicFiles };
}

const build = root => run(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 });

test('Vercel-filtered source builds every public asset and vendor dependency while excluding editable sources', async t => {
  const rules = await readFile(path.join(project, '.vercelignore'), 'utf8');
  const { root, publicFiles } = await deploymentFixture(t, rules);
  for (const filename of privateSources) {
    await assert.rejects(stat(path.join(root, filename)), { code: 'ENOENT' }, `${filename} must not be uploaded`);
  }

  const result = await build(root);
  assert.match(result.stdout, /static build ready/);
  const outputFiles = await filesAt(path.join(root, 'dist'));
  assert.deepEqual(outputFiles, [...publicFiles.map(filename => filename.slice('public/'.length)), ...vendorFiles.map(([, filename]) => filename)].sort());
  for (const filename of publicFiles) {
    assert.deepEqual(await readFile(path.join(root, 'dist', filename.slice('public/'.length))), await readFile(path.join(project, filename)), `${filename} must survive packaging unchanged`);
  }
});

test('the former unanchored assets rule fails the build clearly instead of publishing a broken game', async t => {
  const rules = await readFile(path.join(project, '.vercelignore'), 'utf8');
  const brokenRules = rules.replace(/^\/assets\/$/m, 'assets');
  assert.notEqual(brokenRules, rules, 'The editable-assets exclusion must be anchored at the repository root');
  const { root } = await deploymentFixture(t, brokenRules);
  await assert.rejects(stat(path.join(root, 'public/assets/models/space-drift.glb')), { code: 'ENOENT' });
  await assert.rejects(build(root), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Missing required public asset: public\/assets\/models\/space-drift\.glb/);
    assert.match(error.stderr, /Check \.vercelignore/);
    assert.doesNotMatch(error.stdout, /static build ready/);
    return true;
  });
  await assert.rejects(stat(path.join(root, 'dist')), { code: 'ENOENT' });
});
